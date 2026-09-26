
const { getDatabase } = require("./db");
const { newId, nowIso } = require("./util");
const spacecraftService = require("./spacecraft");
const opportunitiesService = require("./opportunities");
const planning = require("./planning");
const { addTimeline } = require("./events");

const ACTIVE_ASSIGNMENT_STATES = ["scheduled", "executing"];

function activeAssignmentsForSpacecraft(spacecraftId) {
  return getDatabase()
    .prepare(`SELECT * FROM plan_assignments WHERE spacecraft_id = ? AND state IN (${ACTIVE_ASSIGNMENT_STATES.map(() => "?").join(",")})`)
    .all(spacecraftId, ...ACTIVE_ASSIGNMENT_STATES);
}

function activeAssignmentsForOpportunity(opportunityId) {
  return getDatabase()
    .prepare(`SELECT * FROM plan_assignments WHERE opportunity_id = ? AND state IN (${ACTIVE_ASSIGNMENT_STATES.map(() => "?").join(",")})`)
    .all(opportunityId, ...ACTIVE_ASSIGNMENT_STATES);
}

function snapshotAssignment(assignment) {
  const db = getDatabase();
  const order = db.prepare("SELECT ref FROM orders WHERE id = ?").get(assignment.order_id);
  const sc = db.prepare("SELECT ref FROM spacecraft WHERE id = ?").get(assignment.spacecraft_id);
  return {
    assignment_id: assignment.id,
    order_ref: order ? order.ref : null,
    spacecraft_ref: sc ? sc.ref : null,
    opportunity_id: assignment.opportunity_id,
    state: assignment.state,
    displaced_reason: assignment.displaced_reason,
  };
}

// 核心重排：仅传入的受影响订单进入重排，其它订单与已交付产品不动
function replanOrders({ trigger_kind, trigger_ref, detail = "", orderIds, oldAssignments = [], reason }) {
  const db = getDatabase();
  if (orderIds.length === 0) {
    return recordReplan({ trigger_kind, trigger_ref, detail, affected: [], oldAssignments, newAssignments: [], outcome: "no_affected_orders" });
  }

  // 旧分配置为 displaced/cancelled，受影响订单进入待重排
  db.exec("BEGIN");
  try {
    for (const orderId of orderIds) {
      db.prepare("UPDATE orders SET status = 'displaced_pending', updated_at = ? WHERE id = ?").run(nowIso(), orderId);
      addTimeline(orderId, "replan_triggered", { trigger_kind, trigger_ref, detail, reason });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const orderRefs = orderIds.map((id) => db.prepare("SELECT ref FROM orders WHERE id = ?").get(id).ref);

  // 只为受影响订单生成候选并冻结一个重排计划
  let run;
  try {
    run = planning.createPlanRun({
      kind: "replan",
      reason: detail || reason || trigger_kind,
      triggered_by: trigger_ref,
      order_refs: orderRefs,
    });
  } catch (error) {
    return recordReplan({
      trigger_kind, trigger_ref, detail,
      affected: orderRefs, oldAssignments, newAssignments: [],
      outcome: `replanning_failed: ${error.message}`,
    });
  }

  let frozen = null;
  if (run.selections.length > 0) {
    frozen = planning.freezePlanRun(run.id);
  }

  const replanned = [];
  const stranded = [];
  for (const ref of orderRefs) {
    if (frozen && frozen.assignments.some((a) => a.order_ref === ref)) {
      replanned.push(ref);
    } else {
      stranded.push(ref);
      addTimeline(db.prepare("SELECT id FROM orders WHERE ref = ?").get(ref).id, "replan_no_candidate", { trigger_kind, trigger_ref });
    }
  }

  const newAssignments = frozen ? frozen.assignments.map(snapshotAssignment) : [];
  return recordReplan({
    trigger_kind, trigger_ref, detail,
    affected: orderRefs, oldAssignments, newAssignments,
    outcome: stranded.length === 0 ? "replanned" : "partial",
    replanned, stranded, plan_run_id: run.id,
  });
}

function recordReplan(entry) {
  const db = getDatabase();
  const id = newId("rp");
  db.prepare(
    `INSERT INTO replans(id, trigger_kind, trigger_ref, detail, affected_orders, old_assignments, new_assignments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, entry.trigger_kind, entry.trigger_ref, entry.detail,
    JSON.stringify(entry.affected.map((x) => (typeof x === "string" ? x : x.ref))),
    JSON.stringify(entry.oldAssignments), JSON.stringify(entry.newAssignments), nowIso(),
  );
  return getReplan(id);
}

function getReplan(id) {
  const row = getDatabase().prepare("SELECT * FROM replans WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    trigger_kind: row.trigger_kind,
    trigger_ref: row.trigger_ref,
    detail: row.detail,
    affected_orders: JSON.parse(row.affected_orders),
    old_assignments: JSON.parse(row.old_assignments),
    new_assignments: JSON.parse(row.new_assignments),
    created_at: row.created_at,
  };
}

function listReplans() {
  return getDatabase().prepare("SELECT id FROM replans ORDER BY created_at").all().map((r) => getReplan(r.id));
}

// 触发 1：卫星不可用
function handleSpacecraftUnavailable(spacecraftRef, reason = "") {
  const sc = spacecraftService.markSpacecraftUnavailable(spacecraftRef, reason);
  const assignments = activeAssignmentsForSpacecraft(sc.id);
  const db = getDatabase();
  db.exec("BEGIN");
  try {
    for (const a of assignments) {
      db.prepare("UPDATE plan_assignments SET state = 'cancelled', displaced_reason = ? WHERE id = ?")
        .run("spacecraft_unavailable", a.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return replanOrders({
    trigger_kind: "spacecraft_unavailable",
    trigger_ref: sc.ref,
    detail: reason || `卫星 ${sc.ref} 不可用`,
    orderIds: [...new Set(assignments.map((a) => a.order_id))],
    oldAssignments: assignments.map(snapshotAssignment),
  });
}

// 触发 2：机会预报修订
function handleOpportunityRevised(opportunityId, changes) {
  const revised = opportunitiesService.reviseOpportunity(opportunityId, changes);
  const assignments = activeAssignmentsForOpportunity(opportunityId);
  const db = getDatabase();
  for (const a of assignments) {
    db.prepare("UPDATE plan_assignments SET state = 'cancelled', displaced_reason = ? WHERE id = ?")
      .run("opportunity_revised", a.id);
  }
  return replanOrders({
    trigger_kind: "opportunity_revised",
    trigger_ref: opportunityId,
    detail: `机会预报修订，新版本 ${revised.new_opportunity.id}`,
    orderIds: [...new Set(assignments.map((a) => a.order_id))],
    oldAssignments: assignments.map(snapshotAssignment),
  });
}

// 触发 2b：机会撤销
function handleOpportunityRevoked(opportunityId, reason = "") {
  opportunitiesService.revokeOpportunity(opportunityId, reason);
  const assignments = activeAssignmentsForOpportunity(opportunityId);
  const db = getDatabase();
  for (const a of assignments) {
    db.prepare("UPDATE plan_assignments SET state = 'cancelled', displaced_reason = ? WHERE id = ?")
      .run("opportunity_revoked", a.id);
  }
  return replanOrders({
    trigger_kind: "opportunity_revised",
    trigger_ref: opportunityId,
    detail: `机会撤销：${reason}`,
    orderIds: [...new Set(assignments.map((a) => a.order_id))],
    oldAssignments: assignments.map(snapshotAssignment),
  });
}

// 触发 3：执行回执逾期未到（可传入 now 便于测试）
function detectLateReceipts(options = {}) {
  const now = Date.parse(options.now || nowIso());
  const db = getDatabase();
  const pending = db.prepare(
    `SELECT a.*, o.window_end, o.receipt_due_after_minutes
       FROM plan_assignments a
       JOIN imaging_opportunities o ON o.id = a.opportunity_id
      WHERE a.state IN ('scheduled','executing')`,
  ).all();
  const overdue = pending.filter((a) =>
    Date.parse(a.window_end) + a.receipt_due_after_minutes * 60_000 < now);
  if (overdue.length === 0) return { overdue: [], replans: [] };
  for (const a of overdue) {
    db.prepare("UPDATE plan_assignments SET state = 'failed', displaced_reason = 'receipt_late' WHERE id = ?").run(a.id);
  }
  const replan = replanOrders({
    trigger_kind: "receipt_late",
    trigger_ref: options.source_ref || "receipt-monitor",
    detail: "执行回执超过规定期限未到，按未确认处理并触发重排",
    orderIds: [...new Set(overdue.map((a) => a.order_id))],
    oldAssignments: overdue.map(snapshotAssignment),
  });
  return { overdue: overdue.map((a) => a.id), replans: [replan] };
}

module.exports = {
  replanOrders,
  handleSpacecraftUnavailable,
  handleOpportunityRevised,
  handleOpportunityRevoked,
  detectLateReceipts,
  listReplans,
  getReplan,
  snapshotAssignment,
};
