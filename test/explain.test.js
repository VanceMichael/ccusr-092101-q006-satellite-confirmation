
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet, sha256 } = require("./helpers");
const clock = require("../src/clock");

async function seedPlan(post) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z",
    deadline_at: "2026-09-28T00:00:00Z", deliverable: "测绘成果库",
  });
  const run = await post("/plan-runs", {});
  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  return frozen.body.assignments[0];
}

test("订单解释：为何选星、改排经历、实际交付均可追溯", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedPlan(post);

  // 卫星不可用并提供替代机会，形成一次改排
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-28T06:00:00Z", window_end: "2026-09-28T06:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/spacecraft/PIESAT-2-13/unavailable", { reason: "姿控异常" });

  // 完成新分配上的成像与交付
  const assignments = (await get("/assignments?order_ref=ORD-A")).body;
  const current = assignments.find((a) => a.state === "scheduled");
  assert.equal(current.spacecraft_ref, "PIESAT-2-15");
  await post(`/assignments/${current.id}/receipts`, {
    source_ref: "PIESAT-2-15", source_sequence: 1, result: "imaged",
    occurred_at: "2026-09-28T06:05:00Z", received_at: "2026-09-28T06:30:00Z", expected_shards: 1,
  });
  await post(`/assignments/${current.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("d0"), size_bytes: 10,
  });
  await post(`/assignments/${current.id}/assemble`, {});
  await post("/products/PRD-ORD-A/versions/1/deliver", {});

  const explanation = await get("/orders/ORD-A/explanation");
  // 选星
  assert.ok(explanation.body.selection.selected.spacecraft_ref);
  assert.ok(explanation.body.selection.selected.score_breakdown);
  // 改排
  assert.ok(explanation.body.replans.some((r) => r.trigger_kind === "spacecraft_unavailable"));
  // 交付
  assert.equal(explanation.body.products.length >= 1, true);
  assert.equal(explanation.body.deliveries.length, 1);
  assert.ok(explanation.body.timeline.some((t) => t.event_type === "order_displaced" || t.event_type === "replan_triggered"));
  assert.ok(explanation.body.timeline.some((t) => t.event_type === "product_delivered"));
});

test("超期归因：无可行机会长期未排上时责任归于计划编排环节", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  await post("/orders", {
    ref: "ORD-LATE", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-27T00:00:00Z",
    deadline_at: "2026-09-27T00:00:00Z", deliverable: "测绘库",
  });
  // 尝试编排但没有任何可行机会
  const run = await post("/plan-runs", { order_refs: ["ORD-LATE"] });
  assert.equal(run.body.selections.length, 0);
  // 截止时间已过
  clock.setNow("2026-09-27T06:00:00Z");
  const explanation = await get("/orders/ORD-LATE/explanation");
  assert.equal(explanation.body.sla.breached, true);
  assert.equal(explanation.body.sla.responsible_stage, "planning");
});

test("超期归因：卫星不可用导致的重排使超期责任落在卫星可用环节", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedPlan(post);
  // 13 星不可用且无替代机会：重排后订单 stranded；截止时间 09-28
  await post("/spacecraft/PIESAT-2-13/unavailable", { reason: "姿控异常" });
  clock.setNow("2026-09-29T00:00:00Z");
  const explanation = await get("/orders/ORD-A/explanation");
  assert.equal(explanation.body.sla.breached, true);
  assert.equal(explanation.body.sla.responsible_stage, "satellite_availability");
  assert.match(explanation.body.sla.responsible_detail, /姿控异常/);
});

test("按时履约的订单不产生超期责任", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedPlan(post);
  await post(`/assignments/${assignment.id}/receipts`, {
    source_ref: "PIESAT-2-13", source_sequence: 1, result: "imaged",
    occurred_at: "2026-09-27T02:05:00Z", received_at: "2026-09-27T02:30:00Z", expected_shards: 1,
  });
  await post(`/assignments/${assignment.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("d0"), size_bytes: 10,
  });
  await post(`/assignments/${assignment.id}/assemble`, {});
  await post("/products/PRD-ORD-A/versions/1/deliver", {});
  const explanation = await get("/orders/ORD-A/explanation");
  assert.equal(explanation.body.sla.breached, false);
  assert.equal(explanation.body.sla.responsible_stage, null);
});
