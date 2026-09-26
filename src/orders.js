
const { getDatabase } = require("./db");
const {
  newId, nowIso, assert, ConflictError, NotFoundError, parseTime, assertOneOf,
  TIMELINESS_RANK,
} = require("./util");
const targetsService = require("./targets");
const { addTimeline } = require("./events");

const VALID_TIMELINESS = ["routine", "urgent", "emergency"];
const ACTIVE_STATUSES = ["submitted", "candidate", "planned", "scheduled", "displaced_pending", "in_progress"];

function submitOrder(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const ref = String(input.ref || "");
  const department = String(input.department || "");
  const requesterRef = String(input.requester_ref || "");
  const deliverable = String(input.deliverable || "");
  assert(ref, "ref 必填");
  assert(department, "department 必填");
  assert(requesterRef, "requester_ref 必填");
  assert(deliverable, "deliverable 必填");
  const timeliness = String(input.timeliness || "routine");
  assertOneOf(timeliness, VALID_TIMELINESS, "timeliness");
  const imagingMode = String(input.imaging_mode || "");
  assert(imagingMode, "imaging_mode 必填");
  const scopeCode = String(input.scope_code || "");
  assert(scopeCode, "scope_code 必填");
  targetsService.getScope(scopeCode); // 授权范围必须存在
  parseTime(input.window_start, "window_start");
  parseTime(input.window_end, "window_end");
  assert(Date.parse(input.window_start) < Date.parse(input.window_end), "window_start 必须早于 window_end");
  const deadlineAt = input.deadline_at ? parseTime(input.deadline_at, "deadline_at") : input.window_end;

  // 目标可用 ref 或名称/别名提交（不同部门可能以不同名称下单同一目标）
  let target = null;
  if (input.target_ref) {
    target = targetsService.getTarget(String(input.target_ref));
  } else if (input.target_name) {
    target = targetsService.resolveTargetByName(String(input.target_name));
  }
  assert(target, "无法识别目标：请提供已登记的 target_ref 或可解析的 target_name（含别名）");

  const db = getDatabase();
  if (db.prepare("SELECT id FROM orders WHERE ref = ?").get(ref)) {
    throw new ConflictError(`订单 ${ref} 已存在`);
  }

  // 同一目标（含别名）或几何范围重叠的现存订单：只提示，不自动合并
  const overlaps = targetsService.findOverlappingOrders(target, { scopeCode });
  const duplicateFlags = detectDuplicates(overlaps, { imagingMode });

  const id = newId("ord");
  db.prepare(
    `INSERT INTO orders
       (id, ref, department, requester_ref, target_id, target_name_live, scope_code, imaging_mode,
        require_onboard_processing, timeliness, window_start, window_end, deliverable,
        usage_boundary, status, deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?)`,
  ).run(
    id, ref, department, requesterRef, target.id, target.name, scopeCode, imagingMode,
    input.require_onboard_processing ? 1 : 0,
    timeliness, input.window_start, input.window_end, deliverable,
    String(input.usage_boundary || ""), deadlineAt, nowIso(), nowIso(),
  );
  addTimeline(id, "order_submitted", {
    ref, department, target_ref: target.ref, target_name: target.name, scope_code: scopeCode,
    imaging_mode: imagingMode, timeliness, window: [input.window_start, input.window_end],
    deliverable, require_onboard_processing: Boolean(input.require_onboard_processing),
    duplicate_suggestions: duplicateFlags,
  });
  return { ...getOrder(id), duplicate_suggestions: duplicateFlags };
}

// 重复下单识别：
// - 同目标同授权：提示可合并
// - 同目标/同几何但跨授权：标记 sharing_blocked，禁止合并与数据共享
function detectDuplicates(overlaps, ctx) {
  const db = getDatabase();
  const flags = [];
  for (const overlap of overlaps) {
    const other = db.prepare("SELECT * FROM orders WHERE ref = ?").get(overlap.order_ref);
    const sameScope = overlap.same_authorization_scope === true;
    const sameMode = other.imaging_mode === ctx.imagingMode;
    const flag = {
      order_ref: overlap.order_ref,
      department: overlap.department,
      target_name: overlap.target_name,
      overlap_kind: overlap.overlap_kind,
      scope_code: overlap.scope_code,
      same_imaging_mode: sameMode,
      merge_recommended: sameScope && (overlap.overlap_kind === "same_target" || sameMode),
      sharing_allowed: sameScope,
      sharing_blocked: !sameScope,
    };
    if (!sameScope) flag.reason = "授权范围不同：仅提示重叠，不得共享数据或合并订单";
    flags.push(flag);
  }
  return flags;
}

function getOrderRow(idOrRef) {
  const row = getDatabase().prepare("SELECT * FROM orders WHERE id = ? OR ref = ?").get(idOrRef, idOrRef);
  if (!row) throw new NotFoundError(`订单不存在：${idOrRef}`);
  return row;
}

function getOrder(idOrRef) {
  const db = getDatabase();
  const row = getOrderRow(idOrRef);
  const target = db.prepare("SELECT ref, name, bbox FROM targets WHERE id = ?").get(row.target_id);
  return {
    id: row.id,
    ref: row.ref,
    department: row.department,
    requester_ref: row.requester_ref,
    target: target ? { ref: target.ref, name: target.name, bbox: JSON.parse(target.bbox) } : null,
    target_name: row.target_name_live,
    scope_code: row.scope_code,
    imaging_mode: row.imaging_mode,
    require_onboard_processing: Boolean(row.require_onboard_processing),
    timeliness: row.timeliness,
    priority_rank: TIMELINESS_RANK[row.timeliness],
    window_start: row.window_start,
    window_end: row.window_end,
    deliverable: row.deliverable,
    usage_boundary: row.usage_boundary,
    status: row.status,
    deadline_at: row.deadline_at,
    linked_to: row.linked_to,
    duplicate_flags: JSON.parse(row.duplicate_flags),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listOrders(filter = {}) {
  const db = getDatabase();
  let sql = "SELECT id FROM orders";
  const where = [];
  const params = [];
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  if (filter.department) { where.push("department = ?"); params.push(filter.department); }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at";
  return db.prepare(sql).all(...params).map((row) => getOrder(row.id));
}

function updateStatus(orderId, status, extra = {}) {
  const db = getDatabase();
  db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), orderId);
  if (extra.linkedTo) {
    db.prepare("UPDATE orders SET linked_to = ? WHERE id = ?").run(extra.linkedTo, orderId);
  }
  addTimeline(orderId, "status_changed", { status, ...extra });
}

// 接受合并提示：仅当双方授权范围一致才允许；被并订单取消并挂到主订单
function acceptMerge(orderRef, otherRef) {
  const db = getDatabase();
  const primary = getOrderRow(orderRef);
  const other = getOrderRow(otherRef);
  if (primary.id === other.id) throw new ConflictError("不能与自身合并");
  if (!ACTIVE_STATUSES.includes(other.status)) throw new ConflictError(`订单 ${otherRef} 状态 ${other.status}，不可合并`);
  if (hasActiveAssignment(other.id)) {
    throw new ConflictError(`订单 ${otherRef} 已有冻结成像分配，请先通过改排释放后再合并`);
  }
  if (primary.scope_code !== other.scope_code) {
    addTimeline(other.id, "merge_rejected", {
      into: primary.ref, reason: "authorization_scope_mismatch",
      primary_scope: primary.scope_code, other_scope: other.scope_code,
    });
    throw new ConflictError("授权范围不同，禁止合并或共享数据", {
      code: "authorization_scope_mismatch",
      primary_scope: primary.scope_code,
      other_scope: other.scope_code,
    });
  }
  const target = targetsService.getTarget(primary.target_id);
  const overlaps = targetsService.findOverlappingOrders(target, {
    scopeCode: primary.scope_code, excludeOrderId: primary.id,
  });
  if (!overlaps.some((o) => o.order_ref === other.ref)) {
    throw new ConflictError("两单目标范围不重叠，不存在合并提示");
  }
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE orders SET status = 'cancelled', linked_to = ?, updated_at = ? WHERE id = ?")
      .run(primary.id, nowIso(), other.id);
    addTimeline(other.id, "order_merged", { into: primary.ref, by: "task_manager" });
    addTimeline(primary.id, "order_absorbed", { from: other.ref });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { merged_order: getOrder(otherRef), into: getOrder(primary.ref) };
}

function hasActiveAssignment(orderId) {
  return Boolean(getDatabase()
    .prepare("SELECT id FROM plan_assignments WHERE order_id = ? AND state IN ('scheduled','executing','imaged') LIMIT 1")
    .get(orderId));
}

function cancelOrder(orderRef, reason = "") {
  const row = getOrderRow(orderRef);
  if (hasActiveAssignment(row.id)) {
    throw new ConflictError(`订单 ${orderRef} 已有冻结成像分配，请先通过改排/应急流程释放`);
  }
  getDatabase().prepare("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
  addTimeline(row.id, "order_cancelled", { reason });
  return getOrder(row.id);
}

module.exports = {
  submitOrder,
  getOrder,
  getOrderRow,
  listOrders,
  updateStatus,
  acceptMerge,
  cancelOrder,
  ACTIVE_STATUSES,
  VALID_TIMELINESS,
};
