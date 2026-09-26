
const { getOrder } = require("./orders");
const { getOrderTimeline } = require("./events");

// 按订单解释：为什么选中某颗星、经历过哪些改排、实际交付了什么、超期责任落在哪个环节
function explainOrder(db, orderId) {
  const order = getOrder(db, orderId);
  const timeline = getOrderTimeline(db, orderId);

  const candidates = db.prepare(
    `SELECT * FROM candidate_plan WHERE order_id = ? ORDER BY feasible DESC, rank`
  ).all(orderId).map((row) => ({
    candidate_id: row.candidate_id,
    opportunity_id: row.opportunity_id,
    spacecraft_ref: row.spacecraft_ref,
    feasible: Boolean(row.feasible),
    score: row.score,
    rank: row.rank,
    rationale: JSON.parse(row.rationale),
    infeasible_reason: row.infeasible_reason,
    generated_at: row.generated_at,
  }));

  const allocations = db.prepare(
    "SELECT * FROM plan_allocation WHERE order_id = ? ORDER BY scheduled_at"
  ).all(orderId);

  const products = db.prepare(
    "SELECT * FROM data_product_version WHERE order_id = ? ORDER BY version"
  ).all(orderId).map((row) => ({
    version: row.version,
    status: row.status,
    aggregate_checksum: row.aggregate_checksum,
    processing_recipe: row.processing_recipe,
    missing_indices: JSON.parse(row.missing_indices),
    source_plan_id: row.source_plan_id,
    source_allocation_id: row.allocation_id,
    spacecraft_ref: row.spacecraft_ref,
    opportunity_id: row.opportunity_id,
    assembled_at: row.assembled_at,
    withdrawn_at: row.withdrawn_at,
    withdraw_reason: row.withdraw_reason,
  }));

  const replans = db.prepare("SELECT * FROM replan_state WHERE order_id = ? ORDER BY entered_at").all(orderId);
  const approvals = db.prepare(
    `SELECT approval_id, kind, status, approver_ref, note, created_at, decided_at, displaced_allocations
     FROM approval_request WHERE order_id = ? ORDER BY created_at`
  ).all(orderId).map((row) => ({ ...row, displaced_allocations: JSON.parse(row.displaced_allocations) }));

  const selected = selectionExplanation(allocations, candidates);
  const revisions = revisionHistory(timeline, replans, approvals, allocations);
  const delivery = deliverySummary(products);
  const overdue = overdueAssessment(order, allocations, products, timeline, replans);

  return {
    order_id: orderId,
    department: order.department,
    target_name: order.target_name,
    timeliness: order.timeliness,
    data_scope: order.data_scope,
    deadline: order.deadline,
    status: order.status,
    why_this_spacecraft: selected,
    revision_history: revisions,
    delivery,
    overdue_assessment: overdue,
    timeline,
  };
}

function selectionExplanation(allocations, candidates) {
  const active = allocations.find((a) => ["scheduled", "executing", "receipt_confirmed"].includes(a.status))
    || allocations.filter((a) => !["displaced", "failed", "cancelled_unavailable", "cancelled_revision", "cancelled_late"].includes(a.status)).slice(-1)[0]
    || null;
  if (!active) {
    const best = candidates.find((c) => c.feasible && c.rank === 1);
    return best
      ? { state: "not_yet_allocated", best_candidate: summarizeCandidate(best) }
      : { state: "no_feasible_candidate" };
  }
  const candidate = candidates.find((c) => c.opportunity_id === active.opportunity_id && c.feasible);
  return {
    state: "allocated",
    allocation_id: active.allocation_id,
    spacecraft_ref: active.spacecraft_ref,
    opportunity_id: active.opportunity_id,
    imaging_mode: active.imaging_mode,
    via_emergency_approval: active.approval_id || null,
    candidate_score: candidate?.score ?? null,
    score_breakdown: candidate?.rationale?.score_breakdown ?? null,
    evaluated_factors: candidate?.rationale?.factors ?? null,
    reason: active.approval_id
      ? "经应急插单批准后占用该成像机会"
      : "在全部可行候选中综合评分排名第一",
    alternatives: candidates.filter((c) => c.feasible && c.candidate_id !== candidate?.candidate_id)
      .slice(0, 3)
      .map((c) => summarizeCandidate(c)),
  };
}

function summarizeCandidate(candidate) {
  return {
    opportunity_id: candidate.opportunity_id,
    spacecraft_ref: candidate.spacecraft_ref,
    score: candidate.score,
    rank: candidate.rank,
    score_breakdown: candidate.rationale?.score_breakdown ?? null,
  };
}

function revisionHistory(timeline, replans, approvals, allocations) {
  const events = [];
  for (const replan of replans) {
    events.push({
      at: replan.entered_at,
      kind: "replanning_entered",
      trigger: replan.trigger_kind,
      trigger_ref: replan.trigger_ref,
      previous_allocation_id: replan.previous_allocation_id,
      resolved_at: replan.resolved_at,
      new_allocation_id: replan.new_allocation_id,
    });
  }
  for (const approval of approvals) {
    if (approval.status === "approved") {
      events.push({
        at: approval.decided_at,
        kind: "emergency_insertion",
        approval_id: approval.approval_id,
        approver_ref: approval.approver_ref,
      });
    }
  }
  for (const allocation of allocations) {
    if (allocation.status === "displaced" || allocation.status.startsWith("cancelled_") || allocation.status === "failed") {
      events.push({
        at: allocation.scheduled_at,
        kind: "allocation_lost",
        allocation_id: allocation.allocation_id,
        reason: allocation.status,
        displaced_by: allocation.displaced_by_allocation_id || null,
      });
    }
  }
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}

function deliverySummary(products) {
  if (products.length === 0) return { delivered: false, versions: [] };
  const current = products.filter((p) => p.status === "assembled").slice(-1)[0]
    || products.filter((p) => p.status !== "withdrawn").slice(-1)[0]
    || products.slice(-1)[0];
  return {
    delivered: products.some((p) => p.status === "assembled"),
    current_version: current ? current.version : null,
    versions: products,
  };
}

// 超期责任归因：沿时间线定位是哪个环节导致交付超过截止时间
function overdueAssessment(order, allocations, products, timeline, replans) {
  const delivered = products.filter((p) => p.status === "assembled").sort((a, b) =>
    new Date(a.assembled_at) - new Date(b.assembled_at))[0];

  if (!delivered) {
    const now = new Date();
    if (new Date(order.deadline) < now) {
      return { overdue: true, state: "not_delivered", responsibility: attributeOpenOrder(order, replans, timeline), deadline: order.deadline };
    }
    return { overdue: false, state: "in_flight", deadline: order.deadline };
  }

  const deliveredAt = new Date(delivered.assembled_at);
  const deadline = new Date(order.deadline);
  if (deliveredAt <= deadline) {
    return { overdue: false, delivered_at: delivered.assembled_at, deadline: order.deadline, margin_minutes: Math.round((deadline - deliveredAt) / 60000) };
  }

  const segments = buildDelaySegments(order, allocations, products, timeline, replans);
  const responsible = assignResponsibility(segments, deliveredAt, deadline);
  return {
    overdue: true,
    delivered_at: delivered.assembled_at,
    deadline: order.deadline,
    delay_minutes: Math.round((deliveredAt - deadline) / 60000),
    responsibility: responsible,
    segments,
  };
}

// 构造时间消耗分段：登记->候选->冻结->（重排触发/解决）->回执->汇聚
function buildDelaySegments(order, allocations, products, timeline, replans) {
  const at = (kind) => timeline.filter((event) => event.kind === kind).map((event) => event.occurred_at).sort();
  const segments = [];
  const registeredAt = at("order_registered")[0];
  const firstFrozen = at("plan_frozen")[0];
  if (registeredAt && firstFrozen) {
    segments.push({ stage: "intake_to_freeze", owner: "task_manager", minutes: minutesBetween(registeredAt, firstFrozen) });
  }
  for (const replan of replans) {
    const resolved = replan.resolved_at;
    segments.push({
      stage: `replan:${replan.trigger_kind}`,
      owner: ownerOfTrigger(replan.trigger_kind),
      minutes: resolved ? minutesBetween(replan.entered_at, resolved) : minutesBetween(replan.entered_at, new Date()),
      open: !resolved,
      trigger_ref: replan.trigger_ref,
    });
  }
  const executionDelays = [];
  for (const allocation of allocations) {
    if (allocation.executed_at && allocation.receipt_at) {
      executionDelays.push(minutesBetween(allocation.executed_at, allocation.receipt_at));
    }
  }
  if (executionDelays.length) {
    segments.push({ stage: "spacecraft_to_receipt", owner: "spacecraft_segment", minutes: Math.max(...executionDelays) });
  }
  const firstAssembled = at("product_assembled")[0];
  const lastReceipt = allocations.map((a) => a.receipt_at).filter(Boolean).sort().slice(-1)[0];
  if (lastReceipt && firstAssembled) {
    segments.push({ stage: "ground_processing", owner: "ground_segment", minutes: minutesBetween(lastReceipt, firstAssembled) });
  }
  return segments;
}

function ownerOfTrigger(trigger) {
  switch (trigger) {
    case "spacecraft_unavailable":
    case "receipt_late":
    case "receipt_failed":
      return "spacecraft_segment";
    case "opportunity_revised":
      return "orbit_forecast";
    case "emergency_displaced":
      return "emergency_preemption";
    default:
      return "task_manager";
  }
}

function assignResponsibility(segments, deliveredAt, deadline) {
  // 责任归到耗时最长的异常环节；若无异常环节，则归到最长常规环节
  const abnormal = segments.filter((segment) => segment.stage.startsWith("replan:"));
  const pool = abnormal.length ? abnormal : segments;
  const dominant = pool.slice().sort((a, b) => b.minutes - a.minutes)[0];
  return {
    party: dominant.owner,
    stage: dominant.stage,
    consumed_minutes: Math.round(dominant.minutes),
    rationale: abnormal.length
      ? "超期由改排等待造成，按触发来源确定责任环节"
      : "无异常改排，超期消耗主要发生在该常规环节",
  };
}

function attributeOpenOrder(order, replans, timeline) {
  const open = replans.filter((r) => !r.resolved_at);
  if (open.length) {
    const latest = open.sort((a, b) => new Date(b.entered_at) - new Date(a.entered_at))[0];
    return {
      party: ownerOfTrigger(latest.trigger_kind),
      stage: `replan:${latest.trigger_kind}`,
      rationale: "订单已过截止时间仍未交付，且停留在重排队列",
      trigger_ref: latest.trigger_ref,
    };
  }
  const statusOwner = {
    registered: "task_manager",
    candidate: "task_manager",
    planned: "task_manager",
    replanning: "task_manager",
    frozen: "spacecraft_segment",
    in_execution: "ground_segment",
  };
  return {
    party: statusOwner[order.status] || "task_manager",
    stage: `status:${order.status}`,
    rationale: "订单已过截止时间仍未交付，按当前状态定位责任环节",
  };
}

function minutesBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / 60000);
}

module.exports = { explainOrder };
