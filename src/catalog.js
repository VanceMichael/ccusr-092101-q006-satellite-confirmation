
const { inTransaction } = require("./db");
const { acceptInboundEvent, recordOrderEvent } = require("./events");
const {
  nowIso,
  parseIso,
  httpError,
  windowsOverlap,
  bboxOf,
  coverageRatio,
  requireFields,
  asStringArray,
} = require("./util");

const SPACECRAFT_STATUSES = new Set(["available", "unavailable"]);
const OPPORTUNITY_STATUSES = new Set(["forecast", "superseded", "cancelled"]);

// ---- 卫星与能力版本 ----

function registerSpacecraft(db, input, source = {}) {
  requireFields(input, ["spacecraft_ref", "name", "capability_version", "supported_modes", "storage_capacity_mb", "energy_capacity_wh"]);
  const supportedModes = asStringArray(input.supported_modes, "supported_modes");
  const exists = db.prepare("SELECT spacecraft_ref FROM spacecraft WHERE spacecraft_ref = ?").get(input.spacecraft_ref);
  if (exists) throw httpError(409, "spacecraft_exists", `卫星 ${input.spacecraft_ref} 已登记，请使用能力版本更新接口`);

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "spacecraft_registered", payload: input });
    db.prepare(
      `INSERT INTO spacecraft(spacecraft_ref, name, capability_version, supported_modes, onboard_ai,
          storage_capacity_mb, energy_capacity_wh, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'available', ?)`
    ).run(
      input.spacecraft_ref,
      input.name,
      input.capability_version,
      JSON.stringify(supportedModes),
      input.onboard_ai ? 1 : 0,
      input.storage_capacity_mb,
      input.energy_capacity_wh,
      nowIso()
    );
    return getSpacecraft(db, input.spacecraft_ref);
  });
}

// 能力版本升级：旧机会与已冻结计划继续引用旧版本事实；新候选按新版本计算
function updateCapability(db, input, source = {}) {
  requireFields(input, ["spacecraft_ref", "capability_version", "supported_modes", "storage_capacity_mb", "energy_capacity_wh"]);
  const current = getSpacecraft(db, input.spacecraft_ref);
  const supportedModes = asStringArray(input.supported_modes, "supported_modes");
  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "capability_updated", payload: input });
    db.prepare(
      `UPDATE spacecraft SET name = ?, capability_version = ?, supported_modes = ?, onboard_ai = ?,
          storage_capacity_mb = ?, energy_capacity_wh = ?, updated_at = ?
       WHERE spacecraft_ref = ?`
    ).run(
      input.name ?? current.name,
      input.capability_version,
      JSON.stringify(supportedModes),
      input.onboard_ai === undefined ? current.onboard_ai : input.onboard_ai ? 1 : 0,
      input.storage_capacity_mb,
      input.energy_capacity_wh,
      nowIso(),
      input.spacecraft_ref
    );
    return getSpacecraft(db, input.spacecraft_ref);
  });
}

// 卫星不可用：释放其占用中的未来分配，仅受影响订单进入重排
function markSpacecraftUnavailable(db, input, source = {}) {
  requireFields(input, ["spacecraft_ref", "reason"]);
  const spacecraft = getSpacecraft(db, input.spacecraft_ref);
  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "spacecraft_unavailable", payload: input });
    db.prepare("UPDATE spacecraft SET status = 'unavailable', status_reason = ?, updated_at = ? WHERE spacecraft_ref = ?")
      .run(input.reason, nowIso(), input.spacecraft_ref);

    const affected = db
      .prepare(
        `SELECT a.allocation_id, a.order_id, a.opportunity_id FROM plan_allocation a
         JOIN plan p ON p.plan_id = a.plan_id
         WHERE a.spacecraft_ref = ? AND a.status = 'scheduled' AND p.status = 'frozen'`
      )
      .all(input.spacecraft_ref);

    const affectedOrderIds = [];
    for (const allocation of affected) {
      db.prepare("UPDATE plan_allocation SET status = 'cancelled_unavailable' WHERE allocation_id = ?")
        .run(allocation.allocation_id);
      enterReplanning(db, allocation.order_id, {
        trigger_kind: "spacecraft_unavailable",
        trigger_ref: input.spacecraft_ref,
        previous_allocation_id: allocation.allocation_id,
      });
      recordOrderEvent(db, allocation.order_id, "allocation_cancelled", {
        reason: "spacecraft_unavailable",
        spacecraft_ref: input.spacecraft_ref,
        allocation_id: allocation.allocation_id,
        opportunity_id: allocation.opportunity_id,
      });
      affectedOrderIds.push(allocation.order_id);
    }
    return { spacecraft_ref: input.spacecraft_ref, status: "unavailable", affected_order_ids: affectedOrderIds };
  });
}

function markSpacecraftAvailable(db, input, source = {}) {
  requireFields(input, ["spacecraft_ref"]);
  getSpacecraft(db, input.spacecraft_ref);
  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "spacecraft_available", payload: input });
    db.prepare("UPDATE spacecraft SET status = 'available', status_reason = NULL, updated_at = ? WHERE spacecraft_ref = ?")
      .run(nowIso(), input.spacecraft_ref);
    return getSpacecraft(db, input.spacecraft_ref);
  });
}

function getSpacecraft(db, ref) {
  const row = db.prepare("SELECT * FROM spacecraft WHERE spacecraft_ref = ?").get(ref);
  if (!row) throw httpError(404, "spacecraft_not_found", `卫星 ${ref} 不存在`);
  return hydrateSpacecraft(row);
}

function listSpacecraft(db) {
  return db.prepare("SELECT * FROM spacecraft ORDER BY spacecraft_ref").all().map(hydrateSpacecraft);
}

function hydrateSpacecraft(row) {
  return {
    ...row,
    onboard_ai: Boolean(row.onboard_ai),
    supported_modes: JSON.parse(row.supported_modes),
  };
}

// ---- 成像机会预报 ----

function publishOpportunity(db, input, source = {}) {
  requireFields(input, [
    "opportunity_id", "spacecraft_ref", "forecast_version", "window_start", "window_end",
    "imaging_mode", "footprint", "storage_budget_mb", "energy_budget_wh",
  ]);
  const spacecraft = getSpacecraft(db, input.spacecraft_ref);
  const windowStart = parseIso(input.window_start, "window_start");
  const windowEnd = parseIso(input.window_end, "window_end");
  if (windowEnd <= windowStart) throw httpError(400, "invalid_window", "window_end 必须晚于 window_start");
  const bbox = bboxOf(input.footprint);
  if (!spacecraft.supported_modes.includes(input.imaging_mode)) {
    throw httpError(400, "mode_unsupported", `${spacecraft.spacecraft_ref} 能力版本 ${spacecraft.capability_version} 不支持模式 ${input.imaging_mode}`);
  }
  if (db.prepare("SELECT opportunity_id FROM imaging_opportunity WHERE opportunity_id = ?").get(input.opportunity_id)) {
    throw httpError(409, "opportunity_exists", `成像机会 ${input.opportunity_id} 已存在`);
  }
  const expectedReceipt = input.expected_receipt_by ? parseIso(input.expected_receipt_by, "expected_receipt_by").toISOString() : null;

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "opportunity_forecast", payload: input });
    insertOpportunityRow(db, { input, bbox, windowStart, windowEnd, expectedReceipt, revisedOf: null });
    return getOpportunity(db, input.opportunity_id);
  });
}

function insertOpportunityRow(db, { input, bbox, windowStart, windowEnd, expectedReceipt, revisedOf }) {
  db.prepare(
    `INSERT INTO imaging_opportunity(opportunity_id, spacecraft_ref, forecast_version, window_start, window_end,
        imaging_mode, bbox, geometry, storage_budget_mb, energy_budget_wh, expected_receipt_by,
        revised_of, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'forecast', ?)`
  ).run(
    input.opportunity_id,
    input.spacecraft_ref,
    input.forecast_version,
    windowStart.toISOString(),
    windowEnd.toISOString(),
    input.imaging_mode,
    JSON.stringify(bbox),
    JSON.stringify(input.footprint),
    input.storage_budget_mb,
    input.energy_budget_wh,
    expectedReceipt,
    revisedOf,
    nowIso()
  );
}

// 机会预报修订：作废旧版本，仅引用旧机会且尚未执行的冻结分配进入重排；
// 已交付数据的产品继续引用原机会/原计划。整个修订是单一事务。
function reviseOpportunity(db, input, source = {}) {
  requireFields(input, [
    "opportunity_id", "new_opportunity_id", "forecast_version", "window_start", "window_end",
    "imaging_mode", "footprint", "storage_budget_mb", "energy_budget_wh",
  ]);
  const previous = getOpportunity(db, input.opportunity_id);
  if (previous.status !== "forecast") {
    throw httpError(409, "opportunity_not_revisable", `机会 ${input.opportunity_id} 状态为 ${previous.status}，不能修订`);
  }
  const spacecraft = getSpacecraft(db, previous.spacecraft_ref);
  const windowStart = parseIso(input.window_start, "window_start");
  const windowEnd = parseIso(input.window_end, "window_end");
  if (windowEnd <= windowStart) throw httpError(400, "invalid_window", "window_end 必须晚于 window_start");
  const bbox = bboxOf(input.footprint);
  if (!spacecraft.supported_modes.includes(input.imaging_mode)) {
    throw httpError(400, "mode_unsupported", `${spacecraft.spacecraft_ref} 不支持模式 ${input.imaging_mode}`);
  }
  if (db.prepare("SELECT opportunity_id FROM imaging_opportunity WHERE opportunity_id = ?").get(input.new_opportunity_id)) {
    throw httpError(409, "opportunity_exists", `成像机会 ${input.new_opportunity_id} 已存在`);
  }
  const expectedReceipt = input.expected_receipt_by ? parseIso(input.expected_receipt_by, "expected_receipt_by").toISOString() : null;
  const replacementInput = { ...input, opportunity_id: input.new_opportunity_id, spacecraft_ref: previous.spacecraft_ref };

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "opportunity_revised", payload: input });
    insertOpportunityRow(db, {
      input: replacementInput, bbox, windowStart, windowEnd, expectedReceipt,
      revisedOf: input.opportunity_id,
    });
    db.prepare("UPDATE imaging_opportunity SET status = 'superseded' WHERE opportunity_id = ?")
      .run(input.opportunity_id);

    const affected = db
      .prepare(
        `SELECT a.allocation_id, a.order_id FROM plan_allocation a
         JOIN plan p ON p.plan_id = a.plan_id
         WHERE a.opportunity_id = ? AND a.status = 'scheduled' AND p.status = 'frozen'`
      )
      .all(input.opportunity_id);

    const affectedOrderIds = [];
    for (const allocation of affected) {
      db.prepare("UPDATE plan_allocation SET status = 'cancelled_revision' WHERE allocation_id = ?")
        .run(allocation.allocation_id);
      enterReplanning(db, allocation.order_id, {
        trigger_kind: "opportunity_revised",
        trigger_ref: input.new_opportunity_id,
        previous_allocation_id: allocation.allocation_id,
      });
      recordOrderEvent(db, allocation.order_id, "allocation_cancelled", {
        reason: "opportunity_revised",
        opportunity_id: input.opportunity_id,
        new_opportunity_id: input.new_opportunity_id,
        allocation_id: allocation.allocation_id,
      });
      affectedOrderIds.push(allocation.order_id);
    }
    return {
      superseded: input.opportunity_id,
      replacement: getOpportunity(db, input.new_opportunity_id),
      affected_order_ids: affectedOrderIds,
    };
  });
}

function getOpportunity(db, id) {
  const row = db.prepare("SELECT * FROM imaging_opportunity WHERE opportunity_id = ?").get(id);
  if (!row) throw httpError(404, "opportunity_not_found", `成像机会 ${id} 不存在`);
  return hydrateOpportunity(row);
}

function listOpportunities(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.spacecraft_ref) {
    clauses.push("spacecraft_ref = ?");
    params.push(filter.spacecraft_ref);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  } else {
    clauses.push("status = 'forecast'");
  }
  const sql = `SELECT * FROM imaging_opportunity ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY window_start`;
  return db.prepare(sql).all(...params).map(hydrateOpportunity);
}

function hydrateOpportunity(row) {
  return {
    ...row,
    bbox: JSON.parse(row.bbox),
    geometry: row.geometry ? JSON.parse(row.geometry) : null,
  };
}

function enterReplanning(db, orderId, { trigger_kind, trigger_ref, previous_allocation_id }) {
  db.prepare(
    `INSERT INTO replan_state(order_id, trigger_kind, trigger_ref, previous_allocation_id, entered_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET trigger_kind = excluded.trigger_kind,
       trigger_ref = excluded.trigger_ref, previous_allocation_id = excluded.previous_allocation_id,
       resolved_at = NULL, new_allocation_id = NULL, entered_at = excluded.entered_at`
  ).run(orderId, trigger_kind, trigger_ref, previous_allocation_id, nowIso());
  db.prepare("UPDATE observation_order SET status = 'replanning' WHERE order_id = ? AND status != 'delivered'").run(orderId);
}

function resolveReplanning(db, orderId, newAllocationId) {
  db.prepare(
    `UPDATE replan_state SET resolved_at = ?, new_allocation_id = ?
     WHERE order_id = ? AND resolved_at IS NULL`
  ).run(nowIso(), newAllocationId, orderId);
}

// 判断某机会能否覆盖订单：模式、时间窗、目标覆盖、卫星可用、预算、窗口尚未过去
function evaluateOpportunity(order, opportunity, spacecraft, { coverageThreshold = 0.95 } = {}) {
  const factors = {
    mode_match: order.imaging_modes.includes(opportunity.imaging_mode),
    window_overlap: windowsOverlap(
      new Date(order.allowed_start), new Date(order.allowed_end),
      new Date(opportunity.window_start), new Date(opportunity.window_end)
    ),
    window_future: new Date(opportunity.window_end) > new Date(),
    coverage: Number(coverageRatio(order.bbox, opportunity.bbox).toFixed(4)),
    spacecraft_available: spacecraft.status === "available",
    storage_fit: spacecraft.storage_capacity_mb >= order.storage_mb && opportunity.storage_budget_mb >= order.storage_mb,
    energy_fit: spacecraft.energy_capacity_wh >= estimatedEnergy(order) && opportunity.energy_budget_wh >= estimatedEnergy(order),
    capability_version: spacecraft.capability_version,
  };
  factors.feasible = Boolean(
    factors.mode_match && factors.window_overlap && factors.window_future && factors.coverage >= coverageThreshold &&
    factors.spacecraft_available && factors.storage_fit && factors.energy_fit
  );
  return factors;
}

// 成像能耗按数据量线性估算（单位 Wh），作为取舍约束的一部分
function estimatedEnergy(order) {
  return Math.ceil(order.storage_mb / 10);
}

module.exports = {
  registerSpacecraft,
  updateCapability,
  markSpacecraftUnavailable,
  markSpacecraftAvailable,
  getSpacecraft,
  listSpacecraft,
  publishOpportunity,
  reviseOpportunity,
  getOpportunity,
  listOpportunities,
  enterReplanning,
  resolveReplanning,
  evaluateOpportunity,
  estimatedEnergy,
  SPACECRAFT_STATUSES,
  OPPORTUNITY_STATUSES,
};
