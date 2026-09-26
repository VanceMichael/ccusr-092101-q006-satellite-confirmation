
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet } = require("./helpers");

async function seedBasics(post) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31], scope_codes: ["S-MAP"] });
  return [
    await post("/opportunities", {
      spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
      bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1.2, storage_cost: 1.2,
    }),
    await post("/opportunities", {
      spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-27T05:00:00Z", window_end: "2026-09-27T05:10:00Z",
      bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
    }),
    await post("/opportunities", {
      spacecraft_ref: "PIESAT-2-16", window_start: "2026-09-27T03:00:00Z", window_end: "2026-09-27T03:10:00Z",
      bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
    }),
  ];
}

test("候选计划按能力版本与机会生成，选星理由可解释", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedBasics(post);
  const order = await post("/orders", {
    ref: "ORD-SMART", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z",
    deliverable: "测绘库", require_onboard_processing: true,
  });
  assert.equal(order.status, 201);

  const run = await post("/plan-runs", {});
  assert.equal(run.status, 201);
  // 三星有覆盖目标的机会；16星无星上智能处理能力 → 不可行
  const infeasible16 = run.body.infeasible.find((c) => c.spacecraft_ref === "PIESAT-2-16");
  assert.ok(infeasible16);
  assert.match(infeasible16.infeasible_reason, /onboard_processing_unsupported/);
  // 13 与 15 可行，13 能力版本更高胜出
  const selected = run.body.selections[0];
  assert.equal(selected.spacecraft_ref, "PIESAT-2-13");
  assert.ok(selected.score > 0);
  assert.ok(selected.score_breakdown.capability_version > 0);

  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  assert.equal(frozen.status, 201);
  assert.equal(frozen.body.status, "frozen");
  assert.equal(frozen.body.assignments[0].spacecraft_ref, "PIESAT-2-13");

  const explanation = await get("/orders/ORD-SMART/explanation");
  assert.equal(explanation.body.selection.selected.spacecraft_ref, "PIESAT-2-13");
  assert.ok(explanation.body.selection.selected.score_breakdown);
  const considered = explanation.body.selection.alternatives_considered.map((a) => a.spacecraft_ref);
  assert.ok(considered.includes("PIESAT-2-15"));
  assert.ok(considered.includes("PIESAT-2-16"));
});

test("普通测绘订单不要求星上智能时，旧版本 16 星同样可作为候选", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedBasics(post);
  await post("/orders", {
    ref: "ORD-PLAIN", department: "测绘部", requester_ref: "u2", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const run = await post("/plan-runs", {});
  const refs = run.body.candidates.map((c) => c.spacecraft_ref);
  assert.ok(refs.includes("PIESAT-2-16"));
});

test("成像模式不支持、时间窗外、覆盖不足的候选标记为不可行并给出原因", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  // 14 星只有 sar/video 等，且其光学模式不支持；另给一个时间窗外机会
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-14", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["sar"], energy_cost: 1, storage_cost: 1,
  });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-30T02:00:00Z", window_end: "2026-09-30T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-27T04:00:00Z", window_end: "2026-09-27T04:10:00Z",
    bbox: [120, 40, 121, 41], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/orders", {
    ref: "ORD-MODE", department: "测绘部", requester_ref: "u", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const run = await post("/plan-runs", {});
  const reasons = Object.fromEntries(run.body.infeasible.map((c) => [c.spacecraft_ref, c.infeasible_reason]));
  assert.match(reasons["PIESAT-2-14"], /mode_unsupported/);
  assert.match(reasons["PIESAT-2-13"], /outside_allowed_window/);
  assert.match(reasons["PIESAT-2-15"], /insufficient_coverage/);
  assert.equal(run.body.selections.length, 0);
});

test("计划冻结后同一成像机会只能分配一次，重复冻结被拒绝", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  const orderInput = {
    department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  };
  await post("/orders", { ...orderInput, ref: "ORD-A", requester_ref: "u1" });
  const run1 = await post("/plan-runs", {});
  await post(`/plan-runs/${run1.body.id}/freeze`, {});
  // 再次冻结同一计划 → 冲突
  const again = await post(`/plan-runs/${run1.body.id}/freeze`, {});
  assert.equal(again.status, 409);

  // 新订单的新计划：已冻结机会被排除，没有任何可选候选
  await post("/orders", { ...orderInput, ref: "ORD-B", requester_ref: "u2" });
  const run2 = await post("/plan-runs", { order_refs: ["ORD-B"] });
  assert.equal(run2.body.selections.length, 0);
  assert.equal(run2.body.candidates.length, 0);
  const freezeEmpty = await post(`/plan-runs/${run2.body.id}/freeze`, {});
  assert.equal(freezeEmpty.status, 409);
});
