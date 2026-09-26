
const { getDatabase } = require("./db");
const {
  newId, nowIso, assert, ConflictError, NotFoundError, coverageRatio, TIMELINESS_RANK,
} = require("./util");
const ordersService = require("./orders");
const spacecraftService = require("./spacecraft");
const opportunitiesService = require("./opportunities");
const { addTimeline } = require("./events");

const MIN_COVERAGE = 0.8; // 机会条带对目标的最低覆盖率
const PLANNABLE_STATUSES = ["submitted", "candidate", "displaced_pending"];

// ---------- 可行性与评分（选星理由的事实来源）----------

function targetBoxOf(order) {
  const b = order.target.bbox;
  return { minLon: b[0], minLat: b[1], maxLon: b[2], maxLat: b[3] };
}

function oppBox(opp) {
  return { minLon: opp.bbox_min_lon, minLat: opp.bbox_min_lat, maxLon: opp.bbox_max_lon, maxLat: opp.bbox_max_lat };
}

function evaluate(order, opp, sc) {
  const reasons = [];
  if (sc.status !== "available") reasons.push("spacecraft_unavailable");
  if (!sc.metadata.supported_modes.includes(order.imaging_mode)) reasons.push("mode_unsupported_by_spacecraft");
  if (!opp.supported_modes.includes(order.imaging_mode)) reasons.push("mode_unsupported_by_opportunity");
  if (order.require_onboard_processing && !sc.metadata.onboard_intelligence) {
    reasons.push("onboard_processing_unsupported");
  }
  const imagingStart = Date.parse(opp.window_start);
  if (imagingStart < Date.parse(order.window_start) || imagingStart > Date.parse(order.window_end)) {
    reasons.push("outside_allowed_window");
  }
  if (opp.status !== "forecast") reasons.push(`opportunity_${opp.status}`);
  const coverage = coverageRatio(targetBoxOf(order), oppBox(opp));
  if (coverage < MIN_COVERAGE) reasons.push("insufficient_coverage");

  const feasible = reasons.length === 0;
  // 评分：覆盖率 40 + 时效尽早成像 20 + 能耗 10 + 存储 10 + 能力版本 6 + 星上智能 4
  const winSpan = Math.max(1, Date.parse(order.window_end) - Date.parse(order.window_start));
  const earliness = 1 - Math.min(1, Math.max(0, (imagingStart - Date.parse(order.window_start)) / winSpan));
  const capabilityNumber = Number.parseFloat((sc.capability_version || "0").replace(/[^0-9.]/g, "")) || 0;
  const breakdown = {
    coverage: Number((coverage * 40).toFixed(2)),
    earliness: Number((earliness * 20).toFixed(2)),
    energy_efficiency: Number((10 / (1 + opp.energy_cost)).toFixed(2)),
    storage_efficiency: Number((10 / (1 + opp.storage_cost)).toFixed(2)),
    capability_version: Number((capabilityNumber * 3).toFixed(2)),
    onboard_intelligence: order.require_onboard_processing && sc.metadata.onboard_intelligence ? 4 : 0,
  };
  const score = feasible
    ? Number(Object.values(breakdown).reduce((sum, value) => sum + value, 0).toFixed(2))
    : 0;
  return { feasible, infeasible_reason: reasons.join("|"), coverage: Number(coverage.toFixed(3)), score, score_breakdown: breakdown };
}

// ---------- 计划运行与候选 ----------

function listPlannableOrders(orderRefs) {
  const all = ordersService.listOrders().filter((o) => PLANNABLE_STATUSES.includes(o.status));
  if (!orderRefs || orderRefs.length === 0) return all;
  return orderRefs.map((ref) => {
    const order = ordersService.getOrder(ref);
    if (!PLANNABLE_STATUSES.includes(order.status)) {
      throw new ConflictError(`订单 ${ref} 状态 ${order.status}，不参与新编计划`);
    }
    return order;
  });
}

function createPlanRun(options = {}) {
  const db = getDatabase();
  const ordersToPlan = listPlannableOrders(options.order_refs || []);
  const id = newId("run");
  db.prepare(
    `INSERT INTO plan_runs(id, kind, status, reason, triggered_by, created_at)
     VALUES (?, ?, 'open', ?, ?, ?)`,
  ).run(id, options.kind || "planning", options.reason || "", options.triggered_by || "", nowIso());
  const budgets = {
    energy: Number.isFinite(options.energy_budget) ? Number(options.energy_budget) : Infinity,
    storage: Number.isFinite(options.storage_budget) ? Number(options.storage_budget) : Infinity,
  };
  const candidates = generateCandidates(id, ordersToPlan);
  const selections = selectCandidates(ordersToPlan, candidates, budgets);
  storeSelections(id, selections);
  return getPlanRun(id);
}

function generateCandidates(runId, ordersToPlan) {
  const db = getDatabase();
  const spacecrafts = spacecraftService.listSpacecraft();
  // 已被有效分配占用的机会不再参与新候选（同一成像机会只能分配一次）
  const takenOpportunityIds = new Set(
    db.prepare("SELECT opportunity_id FROM plan_assignments WHERE state IN ('scheduled','executing','imaged')")
      .all().map((row) => row.opportunity_id),
  );
  const opps = opportunitiesService.listOpportunities().filter((o) =>
    o.status === "forecast" && !takenOpportunityIds.has(o.id));
  const candidates = [];
  const insert = db.prepare(
    `INSERT INTO plan_candidates
       (id, plan_run_id, order_id, opportunity_id, spacecraft_id, feasible, infeasible_reason, coverage, score, score_breakdown)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const order of ordersToPlan) {
    for (const opp of opps) {
      const sc = spacecrafts.find((s) => s.id === opp.spacecraft_id);
      const verdict = evaluate(order, opp, sc);
      const candidateId = newId("cand");
      insert.run(
        candidateId, runId, order.id, opp.id, sc.id,
        verdict.feasible ? 1 : 0, verdict.infeasible_reason, verdict.coverage, verdict.score,
        JSON.stringify(verdict.score_breakdown),
      );
      candidates.push({
        id: candidateId, run_id: runId, order_id: order.id, order_ref: order.ref,
        opportunity_id: opp.id, spacecraft_id: sc.id, spacecraft_ref: sc.ref,
        capability_version: sc.capability_version,
        window: [opp.window_start, opp.window_end],
        feasible: verdict.feasible, infeasible_reason: verdict.infeasible_reason,
        coverage: verdict.coverage, score: verdict.score, score_breakdown: verdict.score_breakdown,
        energy_cost: opp.energy_cost, storage_cost: opp.storage_cost,
      });
    }
    ordersService.updateStatus(order.id, "candidate", { plan_run_id: runId });
  }
  return candidates;
}

// 排序：时效高者先得；同效按截止时间早者优先
function orderPlanningPriority(a, b) {
  return (
    TIMELINESS_RANK[b.timeliness] - TIMELINESS_RANK[a.timeliness] ||
    Date.parse(a.deadline_at) - Date.parse(b.deadline_at) ||
    a.ref.localeCompare(b.ref)
  );
}

function candidateRanking(a, b) {
  return b.score - a.score || Date.parse(a.window[0]) - Date.parse(b.window[0]) || a.spacecraft_ref.localeCompare(b.spacecraft_ref);
}

// 贪心选择：按订单优先级逐个挑出尚未占用、未超资源预算的最优候选
function selectCandidates(ordersToPlan, candidates, budgets) {
  const takenOpportunities = new Set();
  let usedEnergy = 0;
  let usedStorage = 0;
  const selections = [];
  for (const order of [...ordersToPlan].sort(orderPlanningPriority)) {
    const feasible = candidates
      .filter((c) => c.order_id === order.id && c.feasible && !takenOpportunities.has(c.opportunity_id))
      .sort(candidateRanking);
    const withinBudget = feasible.find((c) =>
      usedEnergy + c.energy_cost <= budgets.energy && usedStorage + c.storage_cost <= budgets.storage);
    if (withinBudget) {
      takenOpportunities.add(withinBudget.opportunity_id);
      usedEnergy += withinBudget.energy_cost;
      usedStorage += withinBudget.storage_cost;
      const alternatives = feasible
        .filter((c) => c.id !== withinBudget.id)
        .sort(candidateRanking)
        .slice(0, 3)
        .map((c) => ({ spacecraft_ref: c.spacecraft_ref, score: c.score, reason: "lower_ranked" }));
      const budgetBlocked = feasible.filter((c) =>
        c.id !== withinBudget.id &&
        (usedEnergy - withinBudget.energy_cost + c.energy_cost > budgets.energy ||
         usedStorage - withinBudget.storage_cost + c.storage_cost > budgets.storage))
        .map((c) => ({ spacecraft_ref: c.spacecraft_ref, reason: "energy_or_storage_budget" }));
      selections.push({
        order_id: order.id, order_ref: order.ref, candidate: withinBudget,
        status: "selected", alternatives, blocked: budgetBlocked,
      });
    } else {
      const reason = feasible.length === 0
        ? "no_feasible_candidate"
        : takenOpportunities.has(feasible[0].opportunity_id)
          ? "opportunity_contention" : "energy_or_storage_budget";
      selections.push({ order_id: order.id, order_ref: order.ref, candidate: null, status: "unselected", reason });
    }
  }
  return selections;
}

function storeSelections(runId, selections) {
  const db = getDatabase();
  for (const selection of selections) {
    if (!selection.candidate) continue;
    db.prepare("UPDATE plan_candidates SET selected = 1 WHERE id = ?").run(selection.candidate.id);
  }
}

function hydrateCandidate(row) {
  const db = getDatabase();
  const opp = opportunitiesService.hydrateOpportunity(
    db.prepare("SELECT * FROM imaging_opportunities WHERE id = ?").get(row.opportunity_id));
  const sc = db.prepare("SELECT ref, capability_version FROM spacecraft WHERE id = ?").get(row.spacecraft_id);
  const order = db.prepare("SELECT ref FROM orders WHERE id = ?").get(row.order_id);
  return {
    id: row.id,
    order_ref: order.ref,
    opportunity_id: row.opportunity_id,
    spacecraft_ref: sc.ref,
    capability_version: sc.capability_version,
    window: [opp.window_start, opp.window_end],
    feasible: Boolean(row.feasible),
    infeasible_reason: row.infeasible_reason,
    coverage: row.coverage,
    score: row.score,
    score_breakdown: JSON.parse(row.score_breakdown),
    selected: Boolean(row.selected),
  };
}

function getPlanRun(idOrRef) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM plan_runs WHERE id = ?").get(idOrRef);
  if (!row) throw new NotFoundError(`计划运行不存在：${idOrRef}`);
  const candidateRows = db.prepare("SELECT * FROM plan_candidates WHERE plan_run_id = ? ORDER BY score DESC").all(row.id);
  const candidates = candidateRows.map(hydrateCandidate);
  const assignmentRows = db.prepare("SELECT * FROM plan_assignments WHERE plan_run_id = ? ORDER BY seq").all(row.id);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    triggered_by: row.triggered_by,
    frozen_at: row.frozen_at,
    created_at: row.created_at,
    candidates: candidates.filter((c) => c.feasible),
    infeasible: candidates.filter((c) => !c.feasible),
    selections: candidates.filter((c) => c.selected),
    assignments: assignmentRows.map(hydrateAssignment),
  };
}

function listPlanRuns() {
  return getDatabase().prepare("SELECT id FROM plan_runs ORDER BY created_at").all().map((r) => getPlanRun(r.id));
}

function hydrateAssignment(row) {
  const db = getDatabase();
  const sc = db.prepare("SELECT ref FROM spacecraft WHERE id = ?").get(row.spacecraft_id);
  const order = db.prepare("SELECT ref FROM orders WHERE id = ?").get(row.order_id);
  const opp = db.prepare(
    "SELECT window_start, window_end, receipt_due_after_minutes FROM imaging_opportunities WHERE id = ?",
  ).get(row.opportunity_id);
  return {
    id: row.id,
    plan_run_id: row.plan_run_id,
    order_id: row.order_id,
    order_ref: order ? order.ref : null,
    spacecraft_id: row.spacecraft_id,
    spacecraft_ref: sc ? sc.ref : null,
    opportunity_id: row.opportunity_id,
    window: opp ? [opp.window_start, opp.window_end] : null,
    receipt_due_at: opp
      ? new Date(Date.parse(opp.window_end) + opp.receipt_due_after_minutes * 60_000).toISOString()
      : null,
    seq: row.seq,
    state: row.state,
    displaced_reason: row.displaced_reason,
    replaced_by_id: row.replaced_by_id,
    created_at: row.created_at,
  };
}

function getAssignment(id) {
  const row = getDatabase().prepare("SELECT * FROM plan_assignments WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`分配不存在：${id}`);
  return hydrateAssignment(row);
}

// ---------- 冻结：同一成像机会只能分配一次（部分唯一索引兜底）----------

function freezePlanRun(runId) {
  const db = getDatabase();
  const run = getPlanRun(runId);
  if (run.status === "frozen") throw new ConflictError("计划已冻结");
  const selected = run.selections;
  if (selected.length === 0) throw new ConflictError("没有可冻结的候选分配");

  db.exec("BEGIN");
  try {
    let seq = 0;
    for (const candidate of selected) {
      const order = ordersService.getOrder(candidate.order_ref);
      const assignmentId = newId("asg");
      db.prepare(
        `INSERT INTO plan_assignments
           (id, plan_run_id, order_id, opportunity_id, spacecraft_id, seq, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      ).run(assignmentId, runId, order.id, candidate.opportunity_id,
        spacecraftService.getSpacecraft(candidate.spacecraft_ref).id, seq++, nowIso());
      ordersService.updateStatus(order.id, "scheduled", {
        plan_run_id: runId, assignment_id: assignmentId,
        selection_rationale: {
          spacecraft_ref: candidate.spacecraft_ref,
          capability_version: candidate.capability_version,
          score: candidate.score,
          score_breakdown: candidate.score_breakdown,
          window: candidate.window,
        },
      });
    }
    db.prepare("UPDATE plan_runs SET status = 'frozen', frozen_at = ? WHERE id = ?").run(nowIso(), runId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) {
      throw new ConflictError("同一成像机会只能分配一次：存在冲突的冻结分配", { cause: error.message });
    }
    throw error;
  }
  return getPlanRun(runId);
}

function listAssignments(filter = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM plan_assignments";
  const where = [];
  const params = [];
  if (filter.state) { where.push("state = ?"); params.push(filter.state); }
  if (filter.orderRef) {
    const order = ordersService.getOrder(filter.orderRef);
    where.push("order_id = ?");
    params.push(order.id);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at";
  return db.prepare(sql).all(...params).map(hydrateAssignment);
}

module.exports = {
  MIN_COVERAGE,
  PLANNABLE_STATUSES,
  evaluate,
  createPlanRun,
  getPlanRun,
  listPlanRuns,
  freezePlanRun,
  listAssignments,
  getAssignment,
  hydrateAssignment,
  targetBoxOf,
  oppBox,
};
