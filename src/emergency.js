
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, TIMELINESS_RANK } = require("./util");
const ordersService = require("./orders");
const spacecraftService = require("./spacecraft");
const opportunitiesService = require("./opportunities");
const planning = require("./planning");
const { addTimeline } = require("./events");

// 应急插单提案：展示将被挤出的订单，等待批准；未批准前不改变任何冻结计划
function proposeEmergencyInsertion(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const order = ordersService.getOrder(String(input.order_ref || ""));
  if (order.timeliness !== "emergency") {
    throw new ConflictError(`订单 ${order.ref} 时效等级为 ${order.timeliness}，应急插单仅接受 emergency 订单`);
  }
  if (!planning.PLANNABLE_STATUSES.includes(order.status)) {
    throw new ConflictError(`订单 ${order.ref} 状态 ${order.status}，不能应急插单`);
  }
  const db = getDatabase();
  if (db.prepare(
    "SELECT id FROM emergency_displacements WHERE emergency_order_id = ? AND approval_status = 'pending'",
  ).get(order.id)) {
    throw new ConflictError(`订单 ${order.ref} 已有待批准的应急插单提案`);
  }

  // 目标冻结计划：默认取最近一个冻结的常规计划
  let runId = input.plan_run_id || null;
  if (!runId) {
    const latest = db.prepare(
      "SELECT id FROM plan_runs WHERE status = 'frozen' AND kind = 'planning' ORDER BY frozen_at DESC LIMIT 1",
    ).get();
    if (!latest) throw new ConflictError("没有已冻结的常规计划，无法应急插单");
    runId = latest.id;
  }
  const run = planning.getPlanRun(runId);
  if (run.status !== "frozen") throw new ConflictError("只能向已冻结的计划应急插单");

  const spacecrafts = spacecraftService.listSpacecraft();
  const opps = opportunitiesService.listOpportunities().filter((o) => o.status === "forecast");
  const activeAssignments = db.prepare(
    "SELECT * FROM plan_assignments WHERE state IN ('scheduled','executing')",
  ).all();
  const takenByOpp = new Map(activeAssignments.map((a) => [a.opportunity_id, a]));

  // 1) 空闲机会中的最优可行候选
  const freeCandidates = [];
  const displaceable = [];
  for (const opp of opps) {
    const sc = spacecrafts.find((s) => s.id === opp.spacecraft_id);
    const verdict = planning.evaluate(order, opp, sc);
    if (!verdict.feasible) continue;
    const occupant = takenByOpp.get(opp.id);
    const entry = { opp, sc, verdict };
    if (!occupant) {
      freeCandidates.push(entry);
    } else {
      const occupantOrder = db.prepare("SELECT * FROM orders WHERE id = ?").get(occupant.order_id);
      const occupantRank = TIMELINESS_RANK[occupantOrder.timeliness] || 0;
      if (occupantRank < TIMELINESS_RANK.emergency) {
        displaceable.push({ ...entry, occupant, occupantOrder });
      }
    }
  }
  const rankEntries = (entries) => entries.sort((a, b) =>
    b.verdict.score - a.verdict.score ||
    Date.parse(a.opp.window_start) - Date.parse(b.opp.window_start));

  let chosen = null;
  let displaced = [];
  if (freeCandidates.length > 0) {
    chosen = rankEntries(freeCandidates)[0];
  } else if (displaceable.length > 0) {
    chosen = rankEntries(displaceable)[0];
    displaced = [{
      assignment_id: chosen.occupant.id,
      order_id: chosen.occupantOrder.id,
      order_ref: chosen.occupantOrder.ref,
      department: chosen.occupantOrder.department,
      timeliness: chosen.occupantOrder.timeliness,
      opportunity_id: chosen.opp.id,
      reason: "emergency_preemption",
    }];
  } else {
    throw new ConflictError("没有可行机会：既无空闲机会，也无可挤出的低时效分配", { order_ref: order.ref });
  }

  const id = newId("emg");
  db.prepare(
    `INSERT INTO emergency_displacements
       (id, emergency_order_id, plan_run_id, chosen_opportunity_id, chosen_spacecraft_id,
        score_breakdown, displaced, approval_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id, order.id, runId, chosen.opp.id, chosen.sc.id,
    JSON.stringify(chosen.verdict.score_breakdown), JSON.stringify(displaced), nowIso(),
  );
  addTimeline(order.id, "emergency_proposed", {
    proposal_id: id, plan_run_id: runId,
    spacecraft_ref: chosen.sc.ref, opportunity_id: chosen.opp.id,
    score: chosen.verdict.score, displaced_orders: displaced.map((d) => d.order_ref),
  });
  return getProposal(id);
}

function getProposal(id) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM emergency_displacements WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`应急插单提案不存在：${id}`);
  return hydrateProposal(row);
}

function hydrateProposal(row) {
  const db = getDatabase();
  const order = db.prepare("SELECT ref FROM orders WHERE id = ?").get(row.emergency_order_id);
  const sc = row.chosen_spacecraft_id
    ? db.prepare("SELECT ref FROM spacecraft WHERE id = ?").get(row.chosen_spacecraft_id) : null;
  return {
    id: row.id,
    emergency_order_ref: order ? order.ref : null,
    plan_run_id: row.plan_run_id,
    chosen_opportunity_id: row.chosen_opportunity_id,
    chosen_spacecraft_ref: sc ? sc.ref : null,
    score_breakdown: JSON.parse(row.score_breakdown),
    displaced_orders: JSON.parse(row.displaced),
    approval_status: row.approval_status,
    approver_ref: row.approver_ref,
    approved_at: row.approved_at,
    decision_note: row.decision_note,
    created_at: row.created_at,
  };
}

function listProposals(filter = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM emergency_displacements";
  const params = [];
  if (filter.approval_status) { sql += " WHERE approval_status = ?"; params.push(filter.approval_status); }
  sql += " ORDER BY created_at";
  return db.prepare(sql).all(...params).map(hydrateProposal);
}

// 批准/驳回应急插单；批准后挤出立即生效，被挤订单进入重排
function decideEmergencyInsertion(proposalId, input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const decision = String(input.decision || "");
  if (!["approve", "reject"].includes(decision)) {
    throw new (require("./util").ValidationError)("decision 必须为 approve 或 reject");
  }
  const approverRef = String(input.approver_ref || "");
  assert(approverRef, "approver_ref 必填：应急插单必须取得批准人");
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM emergency_displacements WHERE id = ?").get(proposalId);
  if (!row) throw new NotFoundError(`应急插单提案不存在：${proposalId}`);
  if (row.approval_status !== "pending") throw new ConflictError("该提案已处理");

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.emergency_order_id);
  const displaced = JSON.parse(row.displaced);

  if (decision === "reject") {
    db.prepare(
      "UPDATE emergency_displacements SET approval_status = 'rejected', approver_ref = ?, approved_at = ?, decision_note = ? WHERE id = ?",
    ).run(approverRef, nowIso(), String(input.note || ""), proposalId);
    addTimeline(order.id, "emergency_rejected", { proposal_id: proposalId, approver_ref: approverRef });
    return getProposal(proposalId);
  }

  db.exec("BEGIN");
  try {
    // 挤出：占用分配标记 displaced，被挤订单进入待重排
    for (const item of displaced) {
      db.prepare(
        "UPDATE plan_assignments SET state = 'displaced', displaced_reason = ? WHERE id = ?",
      ).run("emergency_preemption", item.assignment_id);
      db.prepare("UPDATE orders SET status = 'displaced_pending', updated_at = ? WHERE id = ?")
        .run(nowIso(), item.order_id);
      addTimeline(item.order_id, "order_displaced", {
        by_emergency_order: order.ref, assignment_id: item.assignment_id, reason: "emergency_preemption",
      });
    }
    // 应急订单获得该机会（部分唯一索引保证机会不被双重占用）
    const assignmentId = newId("asg");
    db.prepare(
      `INSERT INTO plan_assignments
         (id, plan_run_id, order_id, opportunity_id, spacecraft_id, seq, state, created_at)
       VALUES (?, ?, ?, ?, ?, 999, 'scheduled', ?)`,
    ).run(assignmentId, row.plan_run_id, order.id, row.chosen_opportunity_id, row.chosen_spacecraft_id, nowIso());
    db.prepare("UPDATE orders SET status = 'scheduled', updated_at = ? WHERE id = ?").run(nowIso(), order.id);
    db.prepare(
      "UPDATE emergency_displacements SET approval_status = 'approved', approver_ref = ?, approved_at = ?, decision_note = ? WHERE id = ?",
    ).run(approverRef, nowIso(), String(input.note || ""), proposalId);
    addTimeline(order.id, "emergency_approved", {
      proposal_id: proposalId, approver_ref: approverRef, assignment_id: assignmentId,
      displaced_orders: displaced.map((d) => d.order_ref),
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // 被挤订单进入重排（仅受影响订单）
  const replanning = require("./replanning");
  const replan = displaced.length > 0
    ? replanning.replanOrders({
        trigger_kind: "emergency_displacement",
        trigger_ref: order.ref,
        detail: `应急插单 ${order.ref} 经 ${approverRef} 批准后挤出`,
        orderIds: displaced.map((d) => d.order_id),
      })
    : null;
  return { ...getProposal(proposalId), replan };
}

module.exports = {
  proposeEmergencyInsertion,
  decideEmergencyInsertion,
  getProposal,
  listProposals,
};
