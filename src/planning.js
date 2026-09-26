
const { inTransaction } = require("./db");
const { recordOrderEvent } = require("./events");
const {
  getOrder,
  listOrders,
} = require("./orders");
const {
  getSpacecraft,
  getOpportunity,
  listOpportunities,
  evaluateOpportunity,
  estimatedEnergy,
  enterReplanning,
} = require("./catalog");
const { nowIso, newId, httpError, requireFields } = require("./util");

const PLANNABLE_STATUSES = ["registered", "candidate", "planned", "replanning"];
const ACTIVE_ALLOCATION_STATUSES = ["scheduled", "executing", "receipt_confirmed"];

// ---- 候选生成与评分 ----

function generateCandidates(db, orderId) {
  const order = getOrder(db, orderId);
  if (order.status === "merged") throw httpError(409, "order_merged", "订单已合并，不能再生成候选");

  const opportunities = listOpportunities(db, { status: "forecast" });
  const spacecraftCache = new Map();
  const candidates = opportunities.map((opportunity) => {
    if (!spacecraftCache.has(opportunity.spacecraft_ref)) {
      spacecraftCache.set(opportunity.spacecraft_ref, getSpacecraft(db, opportunity.spacecraft_ref));
    }
    const spacecraft = spacecraftCache.get(opportunity.spacecraft_ref);
    const factors = evaluateOpportunity(order, opportunity, spacecraft);
    const { score, scoreBreakdown } = scoreCandidate(order, opportunity, spacecraft, factors);
    return { opportunity, spacecraft, factors, score, scoreBreakdown };
  });

  return inTransaction(db, () => {
    db.prepare("DELETE FROM candidate_plan WHERE order_id = ?").run(orderId);
    let rank = 0;
    const saved = candidates
      .filter((candidate) => candidate.factors.feasible)
      .sort((a, b) => b.score - a.score)
      .map((candidate) => {
        rank += 1;
        return persistCandidate(db, order, candidate, rank);
      });
    candidates
      .filter((candidate) => !candidate.factors.feasible)
      .forEach((candidate) => persistCandidate(db, order, candidate, null));

    if (order.status === "registered" || order.status === "replanning") {
      db.prepare("UPDATE observation_order SET status = 'candidate' WHERE order_id = ?").run(orderId);
    }
    recordOrderEvent(db, orderId, "candidates_generated", {
      feasible: saved.length,
      total: candidates.length,
      best: saved[0]
        ? { opportunity_id: saved[0].opportunity_id, spacecraft_ref: saved[0].spacecraft_ref, score: saved[0].score }
        : null,
    });
    return {
      order_id: orderId,
      feasible_candidates: saved,
      infeasible_count: candidates.length - saved.length,
      infeasible: candidates.filter((candidate) => !candidate.factors.feasible).map((candidate) => ({
        opportunity_id: candidate.opportunity.opportunity_id,
        spacecraft_ref: candidate.spacecraft.spacecraft_ref,
        reason: infeasibleReason(candidate.factors),
      })),
    };
  });
}

function persistCandidate(db, order, candidate, rank) {
  const candidateId = newId("cand");
  const reason = candidate.factors.feasible ? null : infeasibleReason(candidate.factors);
  db.prepare(
    `INSERT INTO candidate_plan(candidate_id, order_id, opportunity_id, spacecraft_ref, feasible, score,
        rationale, infeasible_reason, rank, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    candidateId,
    order.order_id,
    candidate.opportunity.opportunity_id,
    candidate.spacecraft.spacecraft_ref,
    candidate.factors.feasible ? 1 : 0,
    candidate.score,
    JSON.stringify({ factors: candidate.factors, score_breakdown: candidate.scoreBreakdown }),
    reason,
    rank,
    nowIso()
  );
  return {
    candidate_id: candidateId,
    opportunity_id: candidate.opportunity.opportunity_id,
    spacecraft_ref: candidate.spacecraft.spacecraft_ref,
    spacecraft_name: candidate.spacecraft.name,
    capability_version: candidate.spacecraft.capability_version,
    imaging_mode: candidate.opportunity.imaging_mode,
    window_start: candidate.opportunity.window_start,
    window_end: candidate.opportunity.window_end,
    score: Number(candidate.score.toFixed(2)),
    rank,
    score_breakdown: candidate.scoreBreakdown,
    infeasible_reason: reason,
  };
}

function infeasibleReason(factors) {
  if (!factors.mode_match) return "imaging_mode_unsupported";
  if (!factors.window_overlap) return "time_window_miss";
  if (!factors.window_future) return "window_already_passed";
  if (factors.coverage < 0.95) return "target_coverage_insufficient";
  if (!factors.spacecraft_available) return "spacecraft_unavailable";
  if (!factors.storage_fit) return "storage_budget_exceeded";
  if (!factors.energy_fit) return "energy_budget_exceeded";
  return "infeasible";
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a) - new Date(b)) / 36e5;
}

// 评分解释“为什么选中这颗星”：交付时限裕度、时效契合、星上智能能力、资源余量、模式偏好
function scoreCandidate(order, opportunity, spacecraft, factors) {
  const breakdown = {};
  let score = 0;

  // 交付时限裕度（30）：预计下传完成早于截止时间越多越稳
  const receiptBy = opportunity.expected_receipt_by || opportunity.window_end;
  const marginHours = (new Date(order.deadline) - new Date(receiptBy)) / 36e5;
  breakdown.delivery_margin_hours = Number(marginHours.toFixed(2));
  score += 30 * clamp01(marginHours / 24);
  breakdown.delivery_margin = Number((30 * clamp01(marginHours / 24)).toFixed(2));

  // 时效契合（40）
  const span = Math.max(1, hoursBetween(order.allowed_end, order.allowed_start));
  const position = clamp01(hoursBetween(opportunity.window_start, order.allowed_start) / span);
  if (order.timeliness === "emergency") {
    // 应急：窗口越早越好
    breakdown.timeliness_fit = Number((40 * (1 - position)).toFixed(2));
  } else if (order.timeliness === "refresh") {
    // 重复区域更新：越靠近允许窗口末端，影像越新鲜
    breakdown.timeliness_fit = Number((40 * position).toFixed(2));
  } else {
    // 常规测绘：居中、留有余量
    breakdown.timeliness_fit = Number((40 * (1 - Math.abs(position - 0.5) * 2 * 0.5)).toFixed(2));
  }
  score += breakdown.timeliness_fit;

  // 星上智能处理能力（10）：四颗星中具备该能力版本的优先，缩短交付链路
  breakdown.onboard_ai = spacecraft.onboard_ai ? 10 : 0;
  score += breakdown.onboard_ai;

  // 资源余量（12）：机会与卫星对本单存储、能耗占用比例
  const storageLoad = order.storage_mb / Math.max(1, opportunity.storage_budget_mb);
  const energyLoad = estimatedEnergy(order) / Math.max(1, opportunity.energy_budget_wh);
  breakdown.resource_headroom = Number((12 * clamp01(1 - (storageLoad + energyLoad) / 2)).toFixed(2));
  score += breakdown.resource_headroom;

  // 模式偏好（5）：订单模式列表首项为首选
  breakdown.preferred_mode = order.imaging_modes[0] === opportunity.imaging_mode ? 5 : 0;
  score += breakdown.preferred_mode;

  // 目标覆盖质量（3）
  breakdown.coverage_quality = Number((3 * factors.coverage).toFixed(2));
  score += breakdown.coverage_quality;

  return { score, scoreBreakdown: breakdown };
}

// ---- 草稿计划 ----

function buildDraftPlan(db, options = {}) {
  const orderIds = options.order_ids && options.order_ids.length
    ? options.order_ids
    : listOrders(db).filter((order) => PLANNABLE_STATUSES.includes(order.status)).map((order) => order.order_id);

  const orders = orderIds.map((id) => {
    const order = getOrder(db, id);
    if (!PLANNABLE_STATUSES.includes(order.status)) {
      throw httpError(409, "order_not_plannable", `订单 ${id} 状态 ${order.status} 不能参与排程`);
    }
    return order;
  });

  return inTransaction(db, () => {
    // 候选保证最新：未生成过候选的订单先按当前卫星能力版本与机会计算
    for (const order of orders) {
      if (db.prepare("SELECT COUNT(*) AS n FROM candidate_plan WHERE order_id = ?").get(order.order_id).n === 0) {
        generateCandidates(db, order.order_id);
      }
    }
    const planId = newId("plan");
    db.prepare("INSERT INTO plan(plan_id, status, created_at) VALUES (?, 'draft', ?)").run(planId, nowIso());

    // 优先级：应急最高，随后按截止时间
    const prioritized = orders.slice().sort((a, b) => {
      if (a.timeliness === "emergency" && b.timeliness !== "emergency") return -1;
      if (b.timeliness === "emergency" && a.timeliness !== "emergency") return 1;
      return new Date(a.deadline) - new Date(b.deadline);
    });

    // 全局机会占用：本草稿内 + 其他冻结计划中的占用
    const takenOpportunities = new Set(
      db.prepare(
        `SELECT opportunity_id FROM plan_allocation WHERE status IN ('scheduled', 'executing', 'receipt_confirmed')`
      ).all().map((row) => row.opportunity_id)
    );

    const allocations = [];
    const unscheduled = [];

    for (const order of prioritized) {
      const candidates = db.prepare(
        "SELECT * FROM candidate_plan WHERE order_id = ? AND feasible = 1 ORDER BY rank"
      ).all(order.order_id);
      // 任务经理可在草稿阶段手工钉选某机会（钉选同样在冻结时接受排他校验）
      const pin = options.pins && options.pins[order.order_id];
      const usable = pin
        ? candidates.find((candidate) => candidate.opportunity_id === pin)
        : candidates.find((candidate) => !takenOpportunities.has(candidate.opportunity_id));
      if (!usable) {
        const reason = pin
          ? "pinned_opportunity_not_feasible"
          : candidates.length === 0 ? "no_feasible_opportunity" : "all_opportunities_taken";
        unscheduled.push({ order_id: order.order_id, timeliness: order.timeliness, reason });
        recordOrderEvent(db, order.order_id, "plan_unscheduled", { reason, pinned_opportunity: pin || null });
        continue;
      }
      const allocationId = newId("alc");
      const imagingMode = getOpportunity(db, usable.opportunity_id).imaging_mode;
      db.prepare(
        `INSERT INTO plan_allocation(allocation_id, plan_id, order_id, opportunity_id, spacecraft_ref,
            imaging_mode, storage_mb, expected_shards, status, scheduled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
      ).run(
        allocationId, planId, order.order_id, usable.opportunity_id, usable.spacecraft_ref,
        imagingMode, order.storage_mb, order.expected_shards, nowIso()
      );
      takenOpportunities.add(usable.opportunity_id);
      db.prepare("UPDATE observation_order SET status = 'planned' WHERE order_id = ?").run(order.order_id);
      recordOrderEvent(db, order.order_id, "draft_allocated", {
        plan_id: planId,
        allocation_id: allocationId,
        opportunity_id: usable.opportunity_id,
        spacecraft_ref: usable.spacecraft_ref,
        score: usable.score,
      });
      allocations.push({
        allocation_id: allocationId,
        order_id: order.order_id,
        opportunity_id: usable.opportunity_id,
        spacecraft_ref: usable.spacecraft_ref,
        imaging_mode: usable.imaging_mode,
        score: usable.score,
      });
    }

    return { plan_id: planId, status: "draft", allocations, unscheduled };
  });
}

function getPlan(db, planId) {
  const plan = db.prepare("SELECT * FROM plan WHERE plan_id = ?").get(planId);
  if (!plan) throw httpError(404, "plan_not_found", `计划 ${planId} 不存在`);
  const allocations = db.prepare("SELECT * FROM plan_allocation WHERE plan_id = ? ORDER BY scheduled_at").all(planId);
  return { ...plan, allocations };
}

// 冻结：草稿分配转为正式占用；同一成像机会此刻起只能分配一次（DB 唯一索引兜底）
function freezePlan(db, planId, actorRef = null) {
  const plan = getPlan(db, planId);
  if (plan.status !== "draft") throw httpError(409, "plan_not_draft", `计划 ${planId} 已冻结`);

  const drafts = plan.allocations.filter((allocation) => allocation.status === "draft");
  if (drafts.length === 0) throw httpError(409, "plan_empty", "草稿中没有可冻结的分配");

  return inTransaction(db, () => {
    for (const allocation of drafts) {
      // 冻结前复核：机会仍为预报、卫星仍可用
      const opportunity = getOpportunity(db, allocation.opportunity_id);
      const spacecraft = getSpacecraft(db, allocation.spacecraft_ref);
      if (opportunity.status !== "forecast") {
        throw httpError(409, "opportunity_stale", `机会 ${opportunity.opportunity_id} 已 ${opportunity.status}，请重排`, {
          allocation_id: allocation.allocation_id,
          order_id: allocation.order_id,
        });
      }
      if (spacecraft.status !== "available") {
        throw httpError(409, "spacecraft_down", `卫星 ${spacecraft.spacecraft_ref} 不可用，请重排`, {
          allocation_id: allocation.allocation_id,
          order_id: allocation.order_id,
        });
      }
      const occupied = db.prepare(
        `SELECT allocation_id FROM plan_allocation
         WHERE opportunity_id = ? AND status IN ('scheduled', 'executing', 'receipt_confirmed')`
      ).get(allocation.opportunity_id);
      if (occupied) {
        throw httpError(409, "opportunity_already_allocated",
          `成像机会 ${allocation.opportunity_id} 已被分配 ${occupied.allocation_id} 占用`,
          { allocation_id: allocation.allocation_id, order_id: allocation.order_id, locked_by: occupied.allocation_id });
      }
    }
    const frozenAt = nowIso();
    db.prepare("UPDATE plan SET status = 'frozen', frozen_at = ? WHERE plan_id = ?").run(frozenAt, planId);
    for (const allocation of drafts) {
      db.prepare("UPDATE plan_allocation SET status = 'scheduled' WHERE allocation_id = ?").run(allocation.allocation_id);
      db.prepare("UPDATE observation_order SET status = 'frozen' WHERE order_id = ?").run(allocation.order_id);
      recordOrderEvent(db, allocation.order_id, "plan_frozen", {
        plan_id: planId,
        allocation_id: allocation.allocation_id,
        opportunity_id: allocation.opportunity_id,
        spacecraft_ref: allocation.spacecraft_ref,
      }, actorRef);
    }
    return getPlan(db, planId);
  });
}

// ---- 应急插单 ----

function prepareEmergencyInsertion(db, input) {
  requireFields(input, ["order_id"]);
  const order = getOrder(db, input.order_id);
  if (order.timeliness !== "emergency") {
    throw httpError(409, "not_emergency_order", `订单 ${input.order_id} 时效等级为 ${order.timeliness}，不能走应急插单`);
  }
  if (["delivered", "merged"].includes(order.status)) {
    throw httpError(409, "order_closed", `订单 ${order.order_id} 状态为 ${order.status}`);
  }

  // 选定机会：显式指定，否则取当前排名第一的可行候选
  let candidate;
  if (input.opportunity_id) {
    candidate = db.prepare(
      "SELECT * FROM candidate_plan WHERE order_id = ? AND opportunity_id = ? AND feasible = 1 ORDER BY rank LIMIT 1"
    ).get(input.order_id, input.opportunity_id);
    if (!candidate) {
      throw httpError(409, "candidate_not_feasible",
        `订单 ${input.order_id} 在机会 ${input.opportunity_id} 上没有可行候选，请先生成候选`);
    }
  } else {
    candidate = db.prepare(
      "SELECT * FROM candidate_plan WHERE order_id = ? AND feasible = 1 ORDER BY rank LIMIT 1"
    ).get(input.order_id);
    if (!candidate) throw httpError(409, "no_feasible_candidate", "应急订单没有可行成像机会");
  }

  // 该机会上的正式占用：已在执行或已回执的分配不能被应急挤出（可能已交付，须继续引用原计划）
  const blocking = db.prepare(
    `SELECT a.*, o.department, o.target_name, o.timeliness AS order_timeliness
     FROM plan_allocation a JOIN observation_order o ON o.order_id = a.order_id
     WHERE a.opportunity_id = ? AND a.status IN ('executing', 'receipt_confirmed')`
  ).all(candidate.opportunity_id);
  if (blocking.length > 0) {
    throw httpError(409, "opportunity_in_execution",
      `机会 ${candidate.opportunity_id} 已在执行/回执阶段，不能应急抢占`,
      { blocking_allocations: blocking.map((row) => row.allocation_id), order_ids: blocking.map((row) => row.order_id) });
  }

  // 该机会上将被挤出的已排订单（必须向批准人展示）
  const displacedRows = db.prepare(
    `SELECT a.*, o.department, o.target_name, o.timeliness AS order_timeliness
     FROM plan_allocation a JOIN observation_order o ON o.order_id = a.order_id
     WHERE a.opportunity_id = ? AND a.status = 'scheduled'`
  ).all(candidate.opportunity_id);

  const displaced = displacedRows.map((row) => ({
    allocation_id: row.allocation_id,
    order_id: row.order_id,
    department: row.department,
    target_name: row.target_name,
    timeliness: row.order_timeliness,
    spacecraft_ref: row.spacecraft_ref,
  }));

  return inTransaction(db, () => {
    const approvalId = newId("apr");
    // 引用被挤出分配所在的冻结计划；机会无占用时建立独立计划承载本次插单
    let hostPlanId = displacedRows[0]?.plan_id;
    if (!hostPlanId) {
      hostPlanId = newId("plan");
      db.prepare("INSERT INTO plan(plan_id, status, created_at) VALUES (?, 'draft', ?)").run(hostPlanId, nowIso());
    }
    db.prepare(
      `INSERT INTO approval_request(approval_id, kind, plan_id, order_id, opportunity_id, spacecraft_ref,
          displaced_allocations, status, created_at)
       VALUES (?, 'emergency_insertion', ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(
      approvalId,
      hostPlanId,
      order.order_id,
      candidate.opportunity_id,
      candidate.spacecraft_ref,
      JSON.stringify(displaced),
      nowIso()
    );

    recordOrderEvent(db, order.order_id, "emergency_insertion_requested", {
      approval_id: approvalId,
      opportunity_id: candidate.opportunity_id,
      spacecraft_ref: candidate.spacecraft_ref,
      displaced,
    });
    for (const item of displaced) {
      recordOrderEvent(db, item.order_id, "facing_displacement", {
        approval_id: approvalId,
        emergency_order_id: order.order_id,
        opportunity_id: candidate.opportunity_id,
      });
    }
    return {
      approval_id: approvalId,
      kind: "emergency_insertion",
      status: "pending",
      emergency_order: {
        order_id: order.order_id,
        department: order.department,
        target_name: order.target_name,
        deadline: order.deadline,
      },
      proposed_allocation: {
        opportunity_id: candidate.opportunity_id,
        spacecraft_ref: candidate.spacecraft_ref,
        imaging_mode: candidate.imaging_mode,
      },
      displaced_orders: displaced,
      requires_approval: true,
      message: displaced.length
        ? `该应急插单将挤出 ${displaced.length} 个已排订单，须经批准后执行`
        : "该机会当前无占用，仍须批准留痕",
    };
  });
}

function decideEmergencyInsertion(db, approvalId, decision, input = {}) {
  if (!["approved", "rejected"].includes(decision)) {
    throw httpError(400, "invalid_decision", "decision 必须是 approved 或 rejected");
  }
  const approval = db.prepare("SELECT * FROM approval_request WHERE approval_id = ?").get(approvalId);
  if (!approval) throw httpError(404, "approval_not_found", `批准单 ${approvalId} 不存在`);
  if (approval.status !== "pending") throw httpError(409, "approval_decided", `批准单已 ${approval.status}`);
  const approverRef = input.approver_ref;
  if (!approverRef) throw httpError(400, "missing_approver", "批准必须携带 approver_ref");

  return inTransaction(db, () => {
    db.prepare(
      "UPDATE approval_request SET status = ?, approver_ref = ?, note = ?, decided_at = ? WHERE approval_id = ?"
    ).run(decision, approverRef, input.note ?? null, nowIso(), approvalId);

    recordOrderEvent(db, approval.order_id, "emergency_insertion_decided", {
      approval_id: approvalId,
      decision,
      approver_ref: approverRef,
      note: input.note ?? null,
    }, approverRef);

    if (decision === "rejected") {
      return { approval_id: approvalId, status: "rejected", allocation: null, displaced: [] };
    }

    // 再次核验占用，防止批准期间机会状态变化
    const currentOccupants = db.prepare(
      `SELECT * FROM plan_allocation
       WHERE opportunity_id = ? AND status IN ('scheduled', 'executing', 'receipt_confirmed')`
    ).all(approval.opportunity_id);
    const inExecution = currentOccupants.find((row) => row.status !== "scheduled");
    if (inExecution) {
      throw httpError(409, "opportunity_in_execution",
        "批准期间该机会已进入执行/回执阶段，不能应急抢占",
        { allocation_id: inExecution.allocation_id, order_id: inExecution.order_id });
    }
    const declared = JSON.parse(approval.displaced_allocations);
    const declaredIds = new Set(declared.map((item) => item.allocation_id));
    const surprise = currentOccupants.find((row) => !declaredIds.has(row.allocation_id));
    if (surprise) {
      throw httpError(409, "occupancy_changed",
        "批准期间机会占用发生变化，出现未展示的占用订单，请重新发起插单",
        { unexpected_allocation_id: surprise.allocation_id, unexpected_order_id: surprise.order_id });
    }

    // 先挤出占用者释放机会，再写入应急分配（满足同一机会唯一占用约束）
    const displacedResults = [];
    for (const occupant of currentOccupants) {
      db.prepare(
        "UPDATE plan_allocation SET status = 'displaced', displaced_by_allocation_id = NULL WHERE allocation_id = ?"
      ).run(occupant.allocation_id);
      displacedResults.push({ order_id: occupant.order_id, allocation_id: occupant.allocation_id, new_status: "replanning" });
    }

    const planId = newId("plan");
    db.prepare("INSERT INTO plan(plan_id, status, created_at, frozen_at) VALUES (?, 'frozen', ?, ?)")
      .run(planId, nowIso(), nowIso());
    const allocationId = newId("alc");
    db.prepare(
      `INSERT INTO plan_allocation(allocation_id, plan_id, order_id, opportunity_id, spacecraft_ref,
          imaging_mode, storage_mb, status, approval_id, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).run(
      allocationId, planId, approval.order_id, approval.opportunity_id, approval.spacecraft_ref,
      imagingModeOf(db, approval.order_id, approval.opportunity_id),
      getOrder(db, approval.order_id).storage_mb,
      approvalId, nowIso()
    );
    db.prepare("UPDATE observation_order SET status = 'frozen' WHERE order_id = ?").run(approval.order_id);

    for (const item of displacedResults) {
      db.prepare("UPDATE plan_allocation SET displaced_by_allocation_id = ? WHERE allocation_id = ?")
        .run(allocationId, item.allocation_id);
      enterReplanning(db, item.order_id, {
        trigger_kind: "emergency_displaced",
        trigger_ref: approval.order_id,
        previous_allocation_id: item.allocation_id,
      });
      recordOrderEvent(db, item.order_id, "allocation_displaced", {
        allocation_id: item.allocation_id,
        emergency_order_id: approval.order_id,
        new_allocation_id: allocationId,
        approval_id: approvalId,
        approver_ref: approverRef,
      }, approverRef);
    }

    recordOrderEvent(db, approval.order_id, "allocation_scheduled", {
      plan_id: planId,
      allocation_id: allocationId,
      opportunity_id: approval.opportunity_id,
      spacecraft_ref: approval.spacecraft_ref,
      via_emergency_approval: approvalId,
    }, approverRef);

    return {
      approval_id: approvalId,
      status: "approved",
      allocation: {
        allocation_id: allocationId,
        plan_id: planId,
        order_id: approval.order_id,
        opportunity_id: approval.opportunity_id,
        spacecraft_ref: approval.spacecraft_ref,
      },
      displaced: displacedResults,
    };
  });
}

function imagingModeOf(db, orderId, opportunityId) {
  const opportunity = getOpportunity(db, opportunityId);
  const order = getOrder(db, orderId);
  if (!order.imaging_modes.includes(opportunity.imaging_mode)) {
    throw httpError(409, "mode_mismatch", "插单机会模式与订单要求不符");
  }
  return opportunity.imaging_mode;
}

function listCandidates(db, orderId) {
  getOrder(db, orderId);
  const rows = db.prepare("SELECT * FROM candidate_plan WHERE order_id = ? ORDER BY feasible DESC, rank, score DESC").all(orderId);
  return rows.map((row) => ({
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
}

function getApproval(db, approvalId) {
  const row = db.prepare("SELECT * FROM approval_request WHERE approval_id = ?").get(approvalId);
  if (!row) throw httpError(404, "approval_not_found", `批准单 ${approvalId} 不存在`);
  return { ...row, displaced_allocations: JSON.parse(row.displaced_allocations) };
}

function listApprovals(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT * FROM approval_request ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at`;
  return db.prepare(sql).all(...params).map((row) => ({ ...row, displaced_allocations: JSON.parse(row.displaced_allocations) }));
}

module.exports = {
  generateCandidates,
  listCandidates,
  buildDraftPlan,
  freezePlan,
  getPlan,
  prepareEmergencyInsertion,
  decideEmergencyInsertion,
  getApproval,
  listApprovals,
  ACTIVE_ALLOCATION_STATUSES,
  PLANNABLE_STATUSES,
};
