
const { inTransaction } = require("./db");
const { acceptInboundEvent, recordOrderEvent } = require("./events");
const { getOrder } = require("./orders");
const {
  getOpportunity,
  getSpacecraft,
  enterReplanning,
  resolveReplanning,
} = require("./catalog");
const { generateCandidates } = require("./planning");
const { nowIso, newId, httpError, requireFields } = require("./util");

// 列出进入重排的订单
function listReplanning(db) {
  return db.prepare(
    `SELECT r.*, o.target_name, o.department, o.timeliness, o.deadline
     FROM replan_state r JOIN observation_order o ON o.order_id = r.order_id
     WHERE r.resolved_at IS NULL ORDER BY r.entered_at`
  ).all();
}

// 执行回执上报：executed / failed / receipt_confirmed
function reportExecution(db, input, source = {}) {
  requireFields(input, ["allocation_id", "result"]);
  if (!["executed", "failed", "receipt_confirmed"].includes(input.result)) {
    throw httpError(400, "invalid_result", "result 必须是 executed | failed | receipt_confirmed");
  }
  const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(input.allocation_id);
  if (!allocation) throw httpError(404, "allocation_not_found", "分配不存在");

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "execution_receipt", payload: input });
    if (input.result === "failed") {
      db.prepare("UPDATE plan_allocation SET status = 'failed', executed_at = ? WHERE allocation_id = ?")
        .run(nowIso(), input.allocation_id);
      enterReplanning(db, allocation.order_id, {
        trigger_kind: "receipt_failed",
        trigger_ref: input.allocation_id,
        previous_allocation_id: input.allocation_id,
      });
      recordOrderEvent(db, allocation.order_id, "execution_failed", {
        allocation_id: input.allocation_id,
        reason: input.reason ?? "execution_failed",
      });
      return { allocation_id: input.allocation_id, status: "failed", order_id: allocation.order_id, replanning: true };
    }
    const nextStatus = input.result === "receipt_confirmed" ? "receipt_confirmed" : "executing";
    const executedAt = input.occurred_at || nowIso();
    db.prepare(
      `UPDATE plan_allocation SET status = ?, executed_at = COALESCE(executed_at, ?),
         receipt_at = CASE WHEN ? = 'receipt_confirmed' THEN ? ELSE receipt_at END
       WHERE allocation_id = ?`
    ).run(nextStatus, executedAt, input.result, executedAt, input.allocation_id);
    if (input.result === "receipt_confirmed") {
      db.prepare("UPDATE observation_order SET status = 'in_execution' WHERE order_id = ? AND status = 'frozen'")
        .run(allocation.order_id);
      recordOrderEvent(db, allocation.order_id, "receipt_confirmed", { allocation_id: input.allocation_id });
    } else {
      recordOrderEvent(db, allocation.order_id, "execution_started", { allocation_id: input.allocation_id });
    }
    return { allocation_id: input.allocation_id, status: nextStatus, order_id: allocation.order_id, replanning: false };
  });
}

// 执行回执晚到：超过机会预计回执时限仍无确认。仅未交付的受影响订单进入重排；
// 已经汇聚交付的数据产品继续引用原计划，不受影响。
function markReceiptLate(db, input, source = {}) {
  requireFields(input, ["allocation_id"]);
  const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(input.allocation_id);
  if (!allocation) throw httpError(404, "allocation_not_found", "分配不存在");
  const delivered = db.prepare(
    "SELECT COUNT(*) AS n FROM data_product_version WHERE allocation_id = ? AND status = 'assembled'"
  ).get(input.allocation_id).n;

  // 已交付产品继续引用原计划：晚到回执不触发任何重排
  if (delivered > 0) {
    return inTransaction(db, () => {
      if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "receipt_late_ignored_delivered", payload: input });
      recordOrderEvent(db, allocation.order_id, "receipt_late_but_delivered", {
        allocation_id: input.allocation_id,
        message: "产品已汇聚交付，继续引用原计划，不触发重排",
      });
      return { allocation_id: input.allocation_id, replanning: false, delivered_products: delivered };
    });
  }

  if (!["scheduled", "executing"].includes(allocation.status)) {
    throw httpError(409, "allocation_not_pending", `分配状态 ${allocation.status} 不适用晚到处理`);
  }

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "receipt_late", payload: input });
    db.prepare("UPDATE plan_allocation SET status = 'cancelled_late' WHERE allocation_id = ?")
      .run(input.allocation_id);
    enterReplanning(db, allocation.order_id, {
      trigger_kind: "receipt_late",
      trigger_ref: input.allocation_id,
      previous_allocation_id: input.allocation_id,
    });
    recordOrderEvent(db, allocation.order_id, "allocation_cancelled", {
      reason: "receipt_late",
      allocation_id: input.allocation_id,
      opportunity_id: allocation.opportunity_id,
    });
    return { allocation_id: input.allocation_id, replanning: true, order_id: allocation.order_id };
  });
}

// 重排：只为给定（或全部待重排）订单重新计算候选并一次性冻结新分配；
// 其他订单不动。找不到可行机会的订单保留在重排队列。
function replan(db, options = {}, actorRef = null) {
  const pending = listReplanning(db);
  const targets = options.order_ids
    ? pending.filter((row) => options.order_ids.includes(row.order_id))
    : pending;
  if (targets.length === 0) {
    return { plan_id: null, allocations: [], still_replanning: [], message: "没有待重排订单" };
  }

  return inTransaction(db, () => {
    // 重算候选（旧机会可能已 superseded，新机会已发布）
    for (const target of targets) {
      generateCandidates(db, target.order_id);
    }

    const takenOpportunities = new Set(
      db.prepare(
        `SELECT opportunity_id FROM plan_allocation WHERE status IN ('scheduled', 'executing', 'receipt_confirmed')`
      ).all().map((row) => row.opportunity_id)
    );

    const planId = newId("plan");
    db.prepare("INSERT INTO plan(plan_id, status, created_at, frozen_at) VALUES (?, 'frozen', ?, ?)")
      .run(planId, nowIso(), nowIso());

    // 应急订单仍优先，其余按截止时间
    const ordered = targets.slice().sort((a, b) => {
      if (a.timeliness === "emergency" && b.timeliness !== "emergency") return -1;
      if (b.timeliness === "emergency" && a.timeliness !== "emergency") return 1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

    const allocations = [];
    const stillReplanning = [];

    for (const target of ordered) {
      const candidate = db.prepare(
        "SELECT * FROM candidate_plan WHERE order_id = ? AND feasible = 1 ORDER BY rank LIMIT 1"
      ).get(target.order_id);

      let chosen = candidate;
      if (!chosen || takenOpportunities.has(chosen.opportunity_id)) {
        chosen = db.prepare(
          "SELECT * FROM candidate_plan WHERE order_id = ? AND feasible = 1 ORDER BY rank"
        ).all(target.order_id).find((row) => !takenOpportunities.has(row.opportunity_id));
      }
      if (!chosen) {
        stillReplanning.push({
          order_id: target.order_id,
          reason: candidate ? "all_opportunities_taken" : "no_feasible_opportunity",
        });
        recordOrderEvent(db, target.order_id, "replan_no_option", {
          trigger_kind: target.trigger_kind,
        });
        continue;
      }
      allocateReplanned(db, { planId, target, candidate: chosen, takenOpportunities, allocations, actorRef });
    }

    return {
      plan_id: planId,
      allocations,
      still_replanning: stillReplanning,
    };
  });
}

function allocateReplanned(db, { planId, target, candidate, takenOpportunities, allocations, actorRef }) {
  // 冻结复核：候选生成时已过滤，此处兜底防止并发窗口内状态变化
  const opportunity = getOpportunity(db, candidate.opportunity_id);
  const spacecraft = getSpacecraft(db, candidate.spacecraft_ref);
  if (opportunity.status !== "forecast" || spacecraft.status !== "available") {
    throw httpError(409, "candidate_stale", "选定候选在重排期间失效，请再次重排", {
      order_id: target.order_id,
      opportunity_id: candidate.opportunity_id,
    });
  }
  const order = getOrder(db, target.order_id);
  const imagingMode = opportunity.imaging_mode;
  const allocationId = newId("alc");
  db.prepare(
    `INSERT INTO plan_allocation(allocation_id, plan_id, order_id, opportunity_id, spacecraft_ref,
        imaging_mode, storage_mb, expected_shards, status, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
  ).run(
    allocationId, planId, order.order_id, candidate.opportunity_id, candidate.spacecraft_ref,
    imagingMode, order.storage_mb, order.expected_shards, nowIso()
  );
  takenOpportunities.add(candidate.opportunity_id);
  db.prepare("UPDATE observation_order SET status = 'frozen' WHERE order_id = ?").run(order.order_id);
  resolveReplanning(db, order.order_id, allocationId);
  recordOrderEvent(db, order.order_id, "replanned", {
    plan_id: planId,
    new_allocation_id: allocationId,
    new_opportunity_id: candidate.opportunity_id,
    new_spacecraft_ref: candidate.spacecraft_ref,
    trigger_kind: target.trigger_kind,
    previous_allocation_id: target.previous_allocation_id,
  }, actorRef);
  allocations.push({
    allocation_id: allocationId,
    order_id: order.order_id,
    opportunity_id: candidate.opportunity_id,
    spacecraft_ref: candidate.spacecraft_ref,
    trigger_kind: target.trigger_kind,
  });
}

module.exports = {
  listReplanning,
  reportExecution,
  markReceiptLate,
  replan,
};
