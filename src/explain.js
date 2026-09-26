
const { getDatabase } = require("./db");
const ordersService = require("./orders");
const planning = require("./planning");
const productsService = require("./products");
const replanningService = require("./replanning");
const { listTimeline, listNotifications } = require("./events");
const { nowMs } = require("./clock");

// 按订单给出完整解释：为何选中某颗星、经历过哪些改排、实际交付了什么、超期责任在哪个环节
function explainOrder(orderRef) {
  const db = getDatabase();
  const order = ordersService.getOrder(orderRef);
  const timeline = listTimeline(order.id);

  // --- 选星理由：来自产生有效分配的那次计划运行的候选记录 ---
  const assignments = planning.listAssignments({ orderRef: order.ref });
  const selection = buildSelectionExplanation(db, order, assignments);

  // --- 改排历史 ---
  const replans = replanningService.listReplans()
    .filter((r) => r.affected_orders.includes(order.ref));

  // --- 交付内容 ---
  const products = productsService.listProducts({ order_ref: order.ref });
  const deliveries = productsService.listDeliveries(order.ref);

  // --- 超期归因 ---
  const sla = assessSla(order, timeline, deliveries, replans);

  return {
    order,
    selection,
    assignments,
    replans,
    products,
    deliveries,
    notifications: listNotifications(order.id),
    sla,
    timeline,
  };
}

function buildSelectionExplanation(db, order, assignments) {
  if (assignments.length === 0) {
    return { selected: null, reason: "尚未获得冻结分配" };
  }
  // 最近一次有效分配
  const active = assignments.find((a) => ["scheduled", "executing", "imaged"].includes(a.state))
    || assignments[assignments.length - 1];
  const candidate = db.prepare(
    `SELECT * FROM plan_candidates
      WHERE plan_run_id = ? AND order_id = ? AND opportunity_id = ?`,
  ).get(active.plan_run_id, order.id, active.opportunity_id);
  const alternatives = db.prepare(
    `SELECT c.*, s.ref AS spacecraft_ref FROM plan_candidates c
       JOIN spacecraft s ON s.id = c.spacecraft_id
      WHERE c.plan_run_id = ? AND c.order_id = ? AND c.opportunity_id != ?
      ORDER BY c.score DESC LIMIT 5`,
  ).all(active.plan_run_id, order.id, active.opportunity_id);
  return {
    selected: {
      spacecraft_ref: active.spacecraft_ref,
      opportunity_id: active.opportunity_id,
      plan_run_id: active.plan_run_id,
      score: candidate ? candidate.score : null,
      score_breakdown: candidate ? JSON.parse(candidate.score_breakdown) : null,
      coverage: candidate ? candidate.coverage : null,
      rationale: candidate
        ? `在计划 ${active.plan_run_id} 中，${active.spacecraft_ref} 以综合得分 ${candidate.score} 胜出（覆盖率、尽早成像、能耗、存储、能力版本、星上智能六项加权）`
        : "分配来自应急插单或改排，评分见对应计划记录",
    },
    alternatives_considered: alternatives.map((a) => ({
      spacecraft_ref: a.spacecraft_ref,
      feasible: Boolean(a.feasible),
      infeasible_reason: a.infeasible_reason || null,
      score: a.score,
      coverage: a.coverage,
    })),
  };
}

// 超期责任判定（确定性、可解释）：
// 1. 若交付未超期 → 无责任
// 2. 若存在影响该订单的改排触发 → 责任归于最后一次触发的环节（卫星/预报/回执/应急）
// 3. 否则按阶段区间定位：截止时间落在哪个阶段，责任就在哪个阶段
function assessSla(order, timeline, deliveries, replans) {
  const deadline = Date.parse(order.deadline_at);
  const firstDelivery = deliveries.find((d) => d.status === "delivered");
  const fulfilledAt = firstDelivery ? Date.parse(firstDelivery.delivered_at) : null;
  const now = nowMs();
  const breached = fulfilledAt ? fulfilledAt > deadline : now > deadline;

  const stage = (name, start, end) => ({ stage: name, start, end });
  const at = (type) => {
    const hit = timeline.find((t) => t.event_type === type);
    return hit ? Date.parse(hit.created_at) : null;
  };
  const submittedAt = at("order_submitted");
  const scheduledAt = timeline.find((t) => t.event_type === "status_changed" && t.detail.status === "scheduled");
  const imagedAt = at("receipt_imaged");
  const assembledAt = at("product_assembled");
  const deliveredAt = at("product_delivered");

  const stages = [
    stage("planning", submittedAt, scheduledAt ? Date.parse(scheduledAt.created_at) : null),
    stage("execution", scheduledAt ? Date.parse(scheduledAt.created_at) : null, imagedAt),
    stage("downlink", imagedAt, assembledAt),
    stage("processing", assembledAt, deliveredAt),
  ];

  if (!breached) {
    return {
      breached: false,
      deadline_at: order.deadline_at,
      fulfilled_at: firstDelivery ? firstDelivery.delivered_at : null,
      responsible_stage: null,
      stages,
    };
  }

  if (replans.length > 0) {
    const last = replans[replans.length - 1];
    const stageByTrigger = {
      spacecraft_unavailable: "satellite_availability",
      opportunity_revised: "opportunity_forecast",
      receipt_late: "execution_receipt",
      execution_failed: "execution_receipt",
      emergency_displacement: "emergency_preemption",
    };
    return {
      breached: true,
      deadline_at: order.deadline_at,
      fulfilled_at: firstDelivery ? firstDelivery.delivered_at : null,
      responsible_stage: stageByTrigger[last.trigger_kind] || last.trigger_kind,
      responsible_detail: `订单受「${last.detail || last.trigger_kind}」影响于 ${last.created_at} 进入重排（${last.id}），导致超期`,
      replan_refs: replans.map((r) => r.id),
      stages,
    };
  }

  // 无改排：定位截止时间落在哪个阶段区间
  for (const s of stages) {
    if (s.start !== null && (s.end === null || deadline <= s.end) && deadline >= s.start) {
      return {
        breached: true,
        deadline_at: order.deadline_at,
        fulfilled_at: firstDelivery ? firstDelivery.delivered_at : null,
        responsible_stage: s.stage,
        responsible_detail: `截止时间 ${order.deadline_at} 处于「${s.stage}」阶段区间内，该阶段未及时完成`,
        stages,
      };
    }
  }
  return {
    breached: true,
    deadline_at: order.deadline_at,
    fulfilled_at: firstDelivery ? firstDelivery.delivered_at : null,
    responsible_stage: "planning",
    responsible_detail: "订单在截止时间前未进入执行阶段，责任归于计划编排环节",
    stages,
  };
}

module.exports = { explainOrder, assessSla };
