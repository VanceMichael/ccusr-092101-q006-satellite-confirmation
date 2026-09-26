
const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../src/server");

let base;
const ctx = {};

async function start() {
  const server = createServer({ databasePath: ":memory:" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  ctx.close = () => new Promise((resolve) => server.close(resolve));
}

async function request(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

// 固定测试时刻：今天 2026-09-26，成像机会集中在 10 月上旬
const T1 = [116.3, 39.8, 116.5, 40.0];
const T2 = [120.0, 30.0, 120.2, 30.2];
const T3 = [105.0, 25.0, 105.2, 25.2];
const TDUP = [100.0, 10.0, 100.2, 10.2];

function shardHash(seed) {
  return require("node:crypto").createHash("sha256").update(seed).digest("hex");
}

test("健康接口返回服务状态", async () => {
  await start();
  const { status, body } = await request("GET", "/health");
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("基础目录：订阅方授权、四颗卫星与成像机会", async () => {
  for (const [ref, scopes] of [
    ["sub-em", ["SCOPE-EM"]],
    ["sub-map", ["SCOPE-MAP"]],
    ["sub-a", ["SCOPE-A"]],
    ["sub-b", ["SCOPE-B"]],
  ]) {
    const r = await request("POST", "/subscribers", { subscriber_ref: ref, granted_scopes: scopes });
    assert.equal(r.status, 200);
  }

  let sequence = 0;
  for (const [ref, name, ai] of [
    ["PIESAT-2-A", "启明星甲", true],
    ["PIESAT-2-B", "启明星乙", false],
    ["PIESAT-2-C", "启明星丙", false],
    ["PIESAT-2-D", "启明星丁", false],
  ]) {
    sequence += 1;
    const r = await request("POST", `/spacecraft?source_ref=LEO-CONTROL&source_sequence=${sequence}`, {
      spacecraft_ref: ref,
      name,
      capability_version: ai ? "AI-2.1" : "BASE-1.4",
      supported_modes: ["optical", "video"],
      onboard_ai: ai,
      storage_capacity_mb: 50000,
      energy_capacity_wh: 5000,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.capability_version, ai ? "AI-2.1" : "BASE-1.4");
  }

  const opportunities = [
    ["OPT-A1", "PIESAT-2-A", "2026-10-01T01:00:00Z", "2026-10-01T01:30:00Z", T1, "2026-10-01T04:00:00Z"],
    ["OPT-B1", "PIESAT-2-B", "2026-10-02T01:00:00Z", "2026-10-02T01:30:00Z", T1, "2026-10-02T04:00:00Z"],
    // C1 晚于 D1，使时效为 refresh 的订单首选 C1
    ["OPT-C1", "PIESAT-2-C", "2026-10-02T02:00:00Z", "2026-10-02T02:30:00Z", T2, "2026-10-02T05:00:00Z"],
    ["OPT-D1", "PIESAT-2-D", "2026-10-01T02:00:00Z", "2026-10-01T02:30:00Z", T2, "2026-10-01T05:00:00Z"],
  ];
  for (const [id, sc, ws, we, footprint, receipt] of opportunities) {
    const r = await request("POST", "/opportunities", {
      opportunity_id: id,
      spacecraft_ref: sc,
      forecast_version: "fv-1",
      window_start: ws,
      window_end: we,
      imaging_mode: "optical",
      footprint,
      storage_budget_mb: 4000,
      energy_budget_wh: 2000,
      expected_receipt_by: receipt,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
});

test("重复下单：不同名称识别为同一目标，跨授权范围只提示且禁止合并/共享", async () => {
  const first = await request("POST", "/orders", {
    department: "部门甲",
    target_name: "阿尔法园区",
    footprint: TDUP,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-a"],
    data_scope: "SCOPE-A",
    storage_mb: 1200,
    deadline: "2026-10-05T00:00:00Z",
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.duplicate_suggestions.length, 0);

  // 另一部门用不同名称、不同授权范围下单同一目标
  const crossScope = await request("POST", "/orders", {
    department: "部门乙",
    target_name: "乙号地块",
    target_aliases: ["阿尔法园区"],
    footprint: TDUP,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-b"],
    data_scope: "SCOPE-B",
    storage_mb: 1200,
    deadline: "2026-10-05T00:00:00Z",
  });
  assert.equal(crossScope.status, 200);
  const suggestion = crossScope.body.duplicate_suggestions[0];
  assert.equal(suggestion.match_kind, "alias_match");
  assert.equal(suggestion.scope_compatible, false);
  assert.equal(suggestion.sharing_allowed, false);
  assert.match(suggestion.recommendation, /不得共享/);
  ctx.crossScopeSuggestionId = suggestion.suggestion_id;

  // 跨授权范围的合并必须被拒绝
  const blocked = await request("POST", `/merge-suggestions/${suggestion.suggestion_id}/accept`, {});
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "scope_crosses_boundary");

  // 交付对象不在订单授权范围内：登记即拒绝，防止擅自共享
  const leak = await request("POST", "/orders", {
    department: "部门甲",
    target_name: "越权交付目标",
    footprint: TDUP,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-b"],
    data_scope: "SCOPE-A",
    storage_mb: 1200,
    deadline: "2026-10-05T00:00:00Z",
  });
  assert.equal(leak.status, 403);
  assert.equal(leak.body.error, "scope_not_granted");

  // 同授权范围的重复目标允许合并
  const sameScope = await request("POST", "/orders", {
    department: "部门甲",
    target_name: "阿尔法重复测绘",
    target_aliases: ["阿尔法园区"],
    footprint: TDUP,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-a"],
    data_scope: "SCOPE-A",
    storage_mb: 1200,
    deadline: "2026-10-05T00:00:00Z",
  });
  const compatible = sameScope.body.duplicate_suggestions.find((s) => s.other_order_id === first.body.order.order_id);
  assert.ok(compatible);
  assert.equal(compatible.scope_compatible, true);
  const merged = await request("POST", `/merge-suggestions/${compatible.suggestion_id}/accept`, {});
  assert.equal(merged.status, 200);
  assert.equal(merged.body.into, first.body.order.order_id);
});

test("候选计划：结合能力版本与机会评分，应急订单越早的机会排名越前", async () => {
  const emergency = await request("POST", "/orders", {
    order_id: "ORD-EM-1",
    department: "应急办",
    target_name: "受灾镇区",
    footprint: T1,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "emergency",
    delivery_recipients: ["sub-em"],
    data_scope: "SCOPE-EM",
    storage_mb: 1200,
    expected_shards: 3,
    deadline: "2026-10-01T12:00:00Z",
  });
  assert.equal(emergency.status, 200);
  ctx.emergencyId = emergency.body.order.order_id;

  const routine = await request("POST", "/orders", {
    order_id: "ORD-RT-1",
    department: "测绘院",
    target_name: "基础测绘图幅",
    footprint: T1,
    // 窗口跨度较大时两机会时效分接近，具备星上智能能力的 A 星凭能力加分排第一；
    // 被应急挤出后 B1 仍是可行的次优候选
    allowed_start: "2026-09-28T00:00:00Z",
    allowed_end: "2026-10-08T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-map"],
    data_scope: "SCOPE-MAP",
    storage_mb: 1200,
    expected_shards: 2,
    deadline: "2026-10-05T00:00:00Z",
  });
  ctx.routineId = routine.body.order.order_id;

  const candidates = await request("POST", `/orders/${ctx.emergencyId}/candidates`, {});
  assert.equal(candidates.status, 200);
  assert.equal(candidates.body.feasible_candidates.length, 2);
  assert.equal(candidates.body.feasible_candidates[0].opportunity_id, "OPT-A1");
  assert.equal(candidates.body.feasible_candidates[0].spacecraft_ref, "PIESAT-2-A");
  assert.ok(candidates.body.feasible_candidates[0].score_breakdown.onboard_ai === 10);
});

test("计划冻结：同成像机会只能被分配一次，冲突在冻结时拒绝", async () => {
  const draftR = await request("POST", "/plans/draft", { order_ids: [ctx.routineId] });
  assert.equal(draftR.status, 200);
  assert.equal(draftR.body.allocations[0].opportunity_id, "OPT-A1");
  ctx.planR = draftR.body.plan_id;

  const draftE = await request("POST", "/plans/draft", {
    order_ids: [ctx.emergencyId],
    pins: { [ctx.emergencyId]: "OPT-A1" },
  });
  ctx.planEStale = draftE.body.plan_id;
  assert.equal(draftE.body.allocations[0].opportunity_id, "OPT-A1");

  const frozenR = await request("POST", `/plans/${ctx.planR}/freeze`, {});
  assert.equal(frozenR.status, 200);
  assert.equal(frozenR.body.status, "frozen");
  ctx.allocR = frozenR.body.allocations[0].allocation_id;

  const frozenE = await request("POST", `/plans/${ctx.planEStale}/freeze`, {});
  assert.equal(frozenE.status, 409);
  assert.equal(frozenE.body.error, "opportunity_already_allocated");
  assert.equal(frozenE.body.details.locked_by, ctx.allocR);
});

test("应急插单：必须展示被挤出订单，无批准不得执行；批准后挤出订单进入重排", async () => {
  const prepared = await request("POST", `/orders/${ctx.emergencyId}/emergency-insertion`, {
    opportunity_id: "OPT-A1",
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.status, "pending");
  assert.equal(prepared.body.displaced_orders.length, 1);
  assert.equal(prepared.body.displaced_orders[0].order_id, ctx.routineId);
  assert.equal(prepared.body.requires_approval, true);
  ctx.approvalId = prepared.body.approval_id;

  // 缺少批准人
  const noApprover = await request("POST", `/approvals/${ctx.approvalId}/approve`, {});
  assert.equal(noApprover.status, 400);

  const approved = await request("POST", `/approvals/${ctx.approvalId}/approve`, {
    approver_ref: "duty-director-7",
    note: "灾情等级一级，同意插单",
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "approved");
  assert.equal(approved.body.allocation.opportunity_id, "OPT-A1");
  assert.deepEqual(approved.body.displaced.map((d) => d.order_id), [ctx.routineId]);
  ctx.allocE = approved.body.allocation.allocation_id;

  const pending = await request("GET", "/replanning");
  assert.ok(pending.body.pending.some((row) => row.order_id === ctx.routineId && row.trigger_kind === "emergency_displaced"));

  // 批准后原占用已释放给应急订单：同机会不能再被第三个订单抢占
  const orderCheck = await request("GET", `/orders/${ctx.routineId}`);
  assert.equal(orderCheck.body.status, "replanning");
});

test("局部重排：仅被挤出的常规订单改到 OPT-B1，应急订单不动", async () => {
  const result = await request("POST", "/replanning/run?actor_ref=task-mgr-2", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.allocations.length, 1);
  assert.equal(result.body.allocations[0].order_id, ctx.routineId);
  assert.equal(result.body.allocations[0].opportunity_id, "OPT-B1");
  ctx.allocR2 = result.body.allocations[0].allocation_id;

  const emergencyOrder = await request("GET", `/orders/${ctx.emergencyId}`);
  assert.equal(emergencyOrder.body.status, "frozen");
  const pending = await request("GET", "/replanning");
  assert.equal(pending.body.pending.length, 0);
});

test("卫星不可用：仅该星上的未来订单进入重排，其他订单不受影响", async () => {
  const refresh = await request("POST", "/orders", {
    order_id: "ORD-RF-1",
    department: "更新中心",
    target_name: "季度更新片区",
    footprint: T2,
    allowed_start: "2026-09-30T00:00:00Z",
    allowed_end: "2026-10-03T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "refresh",
    delivery_recipients: ["sub-map"],
    data_scope: "SCOPE-MAP",
    storage_mb: 800,
    expected_shards: 2,
    deadline: "2026-10-06T00:00:00Z",
  });
  ctx.refreshId = refresh.body.order.order_id;

  // refresh 偏好窗口末端，首选较晚的 OPT-C1
  const candidates = await request("POST", `/orders/${ctx.refreshId}/candidates`, {});
  assert.equal(candidates.body.feasible_candidates[0].opportunity_id, "OPT-C1");

  const draft = await request("POST", "/plans/draft", { order_ids: [ctx.refreshId] });
  await request("POST", `/plans/${draft.body.plan_id}/freeze`, {});
  ctx.allocU = draft.body.allocations[0].allocation_id;
  assert.equal(draft.body.allocations[0].opportunity_id, "OPT-C1");

  const down = await request("POST", "/spacecraft/PIESAT-2-C/unavailable?source_ref=LEO-CONTROL&source_sequence=10", {
    reason: "姿态控制异常",
  });
  assert.deepEqual(down.body.affected_order_ids, [ctx.refreshId]);

  // 应急与常规订单不在受影响列表
  const pending = await request("GET", "/replanning");
  assert.deepEqual(pending.body.pending.map((r) => r.order_id), [ctx.refreshId]);

  const result = await request("POST", "/replanning/run", {});
  assert.equal(result.body.allocations[0].order_id, ctx.refreshId);
  assert.equal(result.body.allocations[0].opportunity_id, "OPT-D1");
  ctx.allocU2 = result.body.allocations[0].allocation_id;
});

test("机会预报修订：旧机会作废，仅引用它的未执行订单重排，已交付引用不变", async () => {
  const setup = await request("POST", "/opportunities", {
    opportunity_id: "OPT-X1",
    spacecraft_ref: "PIESAT-2-A",
    forecast_version: "fv-1",
    window_start: "2026-10-03T03:00:00Z",
    window_end: "2026-10-03T03:30:00Z",
    imaging_mode: "optical",
    footprint: T3,
    storage_budget_mb: 4000,
    energy_budget_wh: 2000,
  });
  assert.equal(setup.status, 200);

  const order = await request("POST", "/orders", {
    order_id: "ORD-RV-1",
    department: "测绘院",
    target_name: "交通走廊",
    footprint: T3,
    allowed_start: "2026-10-02T00:00:00Z",
    allowed_end: "2026-10-04T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-map"],
    data_scope: "SCOPE-MAP",
    storage_mb: 600,
    deadline: "2026-10-07T00:00:00Z",
  });
  ctx.reviseOrderId = order.body.order.order_id;

  const draft = await request("POST", "/plans/draft", { order_ids: [ctx.reviseOrderId] });
  assert.equal(draft.body.allocations[0].opportunity_id, "OPT-X1");
  await request("POST", `/plans/${draft.body.plan_id}/freeze`, {});
  ctx.allocV = draft.body.allocations[0].allocation_id;

  const revised = await request("POST", "/opportunities/OPT-X1/revise?source_ref=ORBIT-DESK&source_sequence=5", {
    new_opportunity_id: "OPT-X2",
    forecast_version: "fv-2",
    window_start: "2026-10-03T06:00:00Z",
    window_end: "2026-10-03T06:30:00Z",
    imaging_mode: "optical",
    footprint: T3,
    storage_budget_mb: 4000,
    energy_budget_wh: 2000,
  });
  assert.equal(revised.status, 200);
  assert.deepEqual(revised.body.affected_order_ids, [ctx.reviseOrderId]);
  assert.equal(revised.body.superseded, "OPT-X1");

  const old = await request("GET", "/opportunities/OPT-X1");
  assert.equal(old.body.status, "superseded");

  const result = await request("POST", "/replanning/run", {});
  assert.equal(result.body.allocations[0].opportunity_id, "OPT-X2");
  ctx.allocV2 = result.body.allocations[0].allocation_id;

  // 其他订单没有被波及
  const emergencyOrder = await request("GET", `/orders/${ctx.emergencyId}`);
  assert.equal(emergencyOrder.body.status, "frozen");
});

test("数据分片：缺片可追踪，校验摘要汇聚为明确版本，订阅方收到状态通知", async () => {
  // 刷新订单先到 1/2 片，缺片检查产生可追踪通知
  await request("POST", "/allocations/" + ctx.allocU2 + "/receipt", { result: "executed" });
  let shard = await request("POST", "/products/shards", {
    allocation_id: ctx.allocU2,
    shard_index: 0,
    checksum_sha256: shardHash("u-0"),
    size_mb: 400,
  });
  assert.equal(shard.body.status, "incomplete");

  const missing = await request("POST", "/products/missing-check", { allocation_id: ctx.allocU2 });
  assert.deepEqual(missing.body.missing_indices, [1]);

  let notifications = await request("GET", `/notifications?subscriber_ref=sub-map&product_id=${ctx.refreshId}`);
  assert.ok(notifications.body.some((n) => n.kind === "shard_missing" && n.status === "delivered"));

  shard = await request("POST", "/products/shards", {
    allocation_id: ctx.allocU2,
    shard_index: 1,
    checksum_sha256: shardHash("u-1"),
    size_mb: 400,
  });
  assert.equal(shard.body.status, "assembled");
  assert.match(shard.body.aggregate_checksum, /^[a-f0-9]{64}$/);

  const refreshOrder = await request("GET", `/orders/${ctx.refreshId}`);
  assert.equal(refreshOrder.body.status, "delivered");

  // 同序号不同摘要：拒绝并要求走重处理
  const conflict = await request("POST", "/products/shards", {
    allocation_id: ctx.allocU2,
    shard_index: 0,
    checksum_sha256: shardHash("u-0-bad"),
    size_mb: 400,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "shard_checksum_conflict");

  // 常规订单两片齐 → v1 汇聚
  await request("POST", "/allocations/" + ctx.allocR2 + "/receipt", { result: "executed" });
  for (const index of [0, 1]) {
    const r = await request("POST", "/products/shards", {
      allocation_id: ctx.allocR2,
      shard_index: index,
      checksum_sha256: shardHash(`r-${index}`),
      size_mb: 600,
    });
    assert.equal(r.status, 200);
    if (index === 1) assert.equal(r.body.status, "assembled");
  }
});

test("重处理产生新版本并通知；撤回版本留痕；通知可确认", async () => {
  const reprocessed = await request("POST", "/products/reprocess?actor_ref=geo-team", {
    order_id: ctx.routineId,
    reason: "辐射定标参数更新",
    processing_recipe: "calibrated-v2",
  });
  assert.equal(reprocessed.status, 200);
  assert.equal(reprocessed.body.new_version, 2);
  assert.equal(reprocessed.body.supersedes, 1);

  // 携带原分片后按新配方自动汇聚为 v2
  const product = await request("GET", `/products/${ctx.routineId}`);
  const v1 = product.body.versions.find((v) => v.version === 1);
  const v2 = product.body.versions.find((v) => v.version === 2);
  assert.equal(v1.superseded_by_version, 2);
  assert.equal(v2.status, "assembled");
  assert.notEqual(v1.aggregate_checksum, v2.aggregate_checksum);

  const notes = await request("GET", `/notifications?subscriber_ref=sub-map&product_id=${ctx.routineId}`);
  assert.ok(notes.body.some((n) => n.kind === "reprocessed" && n.version === 2));
  assert.ok(notes.body.some((n) => n.kind === "assembled" && n.version === 2));

  // 撤回 v1：订阅方收到撤回通知，v2 仍有效，订单保持已交付
  const withdrawn = await request("POST", "/products/withdraw", {
    order_id: ctx.routineId,
    version: 1,
    reason: "定标缺陷，禁止继续使用",
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.status, "withdrawn");
  const withdrawnNotes = await request("GET", `/notifications?subscriber_ref=sub-map&product_id=${ctx.routineId}&status=delivered`);
  const note = withdrawnNotes.body.find((n) => n.kind === "withdrawn");
  assert.ok(note);
  const ack = await request("POST", `/notifications/${note.notification_id}/ack`, { subscriber_ref: "sub-map" });
  assert.equal(ack.body.status, "acked");

  const stillDelivered = await request("GET", `/orders/${ctx.routineId}`);
  assert.equal(stillDelivered.body.status, "delivered");
});

test("执行回执晚到：已交付产品继续引用原计划；未交付订单进入重排", async () => {
  // 常规订单已交付：晚到判定不触发重排
  const lateDelivered = await request("POST", `/allocations/${ctx.allocR2}/late?source_ref=LEO-CONTROL&source_sequence=20`, {});
  assert.equal(lateDelivered.body.replanning, false);
  assert.ok(lateDelivered.body.delivered_products >= 1);

  // 修订机会上的订单尚未执行：晚到 → 重排
  const lateOpen = await request("POST", `/allocations/${ctx.allocV2}/late?source_ref=LEO-CONTROL&source_sequence=21`, {});
  assert.equal(lateOpen.status, 200);
  assert.equal(lateOpen.body.replanning, true);
  assert.equal(lateOpen.body.order_id, ctx.reviseOrderId);
});

test("订单解释：选中原因、改排经历、交付版本与超期责任环节", async () => {
  // 应急订单：解释为经批准的插单占用
  const emExplain = await request("GET", `/orders/${ctx.emergencyId}/explain`);
  assert.equal(emExplain.status, 200);
  assert.equal(emExplain.body.why_this_spacecraft.state, "allocated");
  assert.ok(emExplain.body.why_this_spacecraft.via_emergency_approval);
  assert.equal(emExplain.body.why_this_spacecraft.opportunity_id, "OPT-A1");
  assert.ok(emExplain.body.why_this_spacecraft.score_breakdown);

  // 常规订单：经历被挤出 → 重排到 B1 → 交付两个版本
  const rtExplain = await request("GET", `/orders/${ctx.routineId}/explain`);
  const triggers = rtExplain.body.revision_history.map((event) => event.trigger).filter(Boolean);
  assert.ok(triggers.includes("emergency_displaced"));
  assert.equal(rtExplain.body.delivery.delivered, true);
  assert.equal(rtExplain.body.delivery.current_version, 2);
  assert.equal(rtExplain.body.overdue_assessment.overdue, false);

  // 构造一个已过截止时间仍滞留在重排队列的订单，责任应落在星上段（回执晚到）。
  // OPT-X2 已因上一个用例的晚到回执释放，新订单占用它后再判定晚到。
  const overdueOrder = await request("POST", "/orders", {
    order_id: "ORD-LATE-1",
    department: "测绘院",
    target_name: "滞留图幅",
    footprint: T3,
    allowed_start: "2026-10-02T00:00:00Z",
    allowed_end: "2026-10-04T00:00:00Z",
    imaging_modes: ["optical"],
    timeliness: "routine",
    delivery_recipients: ["sub-map"],
    data_scope: "SCOPE-MAP",
    storage_mb: 600,
    deadline: "2026-09-20T00:00:00Z",
  });
  const draft = await request("POST", "/plans/draft", { order_ids: [overdueOrder.body.order.order_id] });
  const frozen = await request("POST", `/plans/${draft.body.plan_id}/freeze`, {});
  assert.equal(frozen.status, 200);
  const overdueAlloc = frozen.body.allocations[0].allocation_id;
  await request("POST", `/allocations/${overdueAlloc}/late`, {});

  const explain = await request("GET", `/orders/${overdueOrder.body.order.order_id}/explain`);
  assert.equal(explain.body.overdue_assessment.overdue, true);
  assert.equal(explain.body.overdue_assessment.responsibility.party, "spacecraft_segment");
  assert.equal(explain.body.overdue_assessment.responsibility.stage, "replan:receipt_late");
});

test("收尾：关闭服务", async () => {
  await ctx.close();
});
