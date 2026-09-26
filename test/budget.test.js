
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet } = require("./helpers");

async function seedTwoOpportunities(post) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/scopes", { code: "S-EMG", owner_dept: "应急部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  // 13、14 星各有一个覆盖目标的机会，均为高能耗
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 6, storage_cost: 6,
  });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-14", window_start: "2026-09-27T03:00:00Z", window_end: "2026-09-27T03:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 6, storage_cost: 6,
  });
}

test("能源与星上存储预算受限时，高时效订单优先获得资源，低时效订单留在计划外", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedTwoOpportunities(post);

  await post("/orders", {
    ref: "ORD-ROUTINE", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  await post("/orders", {
    ref: "ORD-URGENT", department: "应急部", requester_ref: "u2", target_ref: "TGT-A",
    scope_code: "S-EMG", imaging_mode: "optical_hr", timeliness: "urgent",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "应急席",
  });

  // 总能源/存储预算只够一个高能耗机会
  const run = await post("/plan-runs", { energy_budget: 8, storage_budget: 8 });
  assert.equal(run.body.selections.length, 1, "预算只允许一个订单入选");
  assert.equal(run.body.selections[0].order_ref, "ORD-URGENT");

  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  assert.equal(frozen.body.assignments.length, 1);
  assert.equal(frozen.body.assignments[0].order_ref, "ORD-URGENT");

  // 常规订单仍处于 candidate，未获得冻结分配
  const routine = await get("/orders/ORD-ROUTINE");
  assert.equal(routine.body.status, "candidate");
});

test("预算放宽后同一批订单可同时入选", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedTwoOpportunities(post);
  for (const [ref, tl] of [["ORD-A", "routine"], ["ORD-B", "routine"]]) {
    await post("/orders", {
      ref, department: "测绘部", requester_ref: "u", target_ref: "TGT-A",
      scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: tl,
      window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
    });
  }
  const run = await post("/plan-runs", { energy_budget: 20, storage_budget: 20 });
  assert.equal(run.body.selections.length, 2);
  // 两个机会分别被两单占用，同一机会不重复
  const oppIds = run.body.selections.map((s) => s.opportunity_id);
  assert.equal(new Set(oppIds).size, 2);
});
