
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet } = require("./helpers");

async function seedFrozenRoutine(post) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/scopes", { code: "S-EMG", owner_dept: "应急部" });
  await post("/targets", {
    ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31], scope_codes: ["S-MAP", "S-EMG"],
  });
  // 只有一个覆盖目标的机会，归 13 星
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/orders", {
    ref: "ORD-ROUTINE", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const run = await post("/plan-runs", {});
  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  return frozen.body;
}

test("应急插单必须展示被挤出的订单，未批准前不改变计划", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenRoutine(post);

  const emergencyOrder = await post("/orders", {
    ref: "ORD-FIRE", department: "应急部", requester_ref: "u9", target_ref: "TGT-A",
    scope_code: "S-EMG", imaging_mode: "optical_hr", timeliness: "emergency",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-27T12:00:00Z", deliverable: "应急值班席",
  });
  assert.equal(emergencyOrder.status, 201);

  const proposal = await post("/emergency/insertions", { order_ref: "ORD-FIRE" });
  assert.equal(proposal.status, 201);
  assert.equal(proposal.body.approval_status, "pending");
  assert.equal(proposal.body.chosen_spacecraft_ref, "PIESAT-2-13");
  assert.equal(proposal.body.displaced_orders.length, 1);
  assert.equal(proposal.body.displaced_orders[0].order_ref, "ORD-ROUTINE");

  // 提案未批准前，原订单仍为 scheduled
  const routine = await get("/orders/ORD-ROUTINE");
  assert.equal(routine.body.status, "scheduled");

  // 缺少批准人 → 拒绝
  const noApprover = await post(`/emergency/insertions/${proposal.body.id}/decision`, { decision: "approve" });
  assert.equal(noApprover.status, 400);

  // 驳回：计划不变
  const reject = await post(`/emergency/insertions/${proposal.body.id}/decision`, {
    decision: "reject", approver_ref: "MGR-1", note: "维持测绘计划",
  });
  assert.equal(reject.status, 201);
  assert.equal((await get("/orders/ORD-ROUTINE")).body.status, "scheduled");

  // 已处理的提案不能再次决策
  const again = await post(`/emergency/insertions/${proposal.body.id}/decision`, {
    decision: "approve", approver_ref: "MGR-1",
  });
  assert.equal(again.status, 409);
});

test("应急插单批准后挤出原订单、机会归应急订单，并为被挤订单触发重排", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenRoutine(post);

  // 为被挤订单准备另一个可用机会（15 星），使其重排成功
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-28T02:00:00Z", window_end: "2026-09-28T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });

  await post("/orders", {
    ref: "ORD-FIRE", department: "应急部", requester_ref: "u9", target_ref: "TGT-A",
    scope_code: "S-EMG", imaging_mode: "optical_hr", timeliness: "emergency",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-27T12:00:00Z", deliverable: "应急值班席",
  });
  const proposal = await post("/emergency/insertions", { order_ref: "ORD-FIRE" });
  assert.equal(proposal.body.displaced_orders[0].order_ref, "ORD-ROUTINE");

  const approved = await post(`/emergency/insertions/${proposal.body.id}/decision`, {
    decision: "approve", approver_ref: "DUTY-MGR-2", note: "灾情优先",
  });
  assert.equal(approved.status, 201);
  assert.equal(approved.body.approval_status, "approved");

  const fire = await get("/orders/ORD-FIRE");
  assert.equal(fire.body.status, "scheduled");
  const routine = await get("/orders/ORD-ROUTINE");
  // 被挤后重排到 15 星的新机会
  assert.equal(routine.body.status, "scheduled");
  const routineAssignments = await get("/assignments?order_ref=ORD-ROUTINE");
  const states = routineAssignments.body.map((a) => a.state);
  assert.ok(states.includes("displaced"));
  assert.ok(states.includes("scheduled"));
  const newAssignment = routineAssignments.body.find((a) => a.state === "scheduled");
  assert.equal(newAssignment.spacecraft_ref, "PIESAT-2-15");

  // 同一机会最终只有一个有效分配
  const allAssignments = await get("/assignments");
  const activeByOpp = new Map();
  for (const a of allAssignments.body.filter((x) => ["scheduled", "executing", "imaged"].includes(x.state))) {
    assert.equal(activeByOpp.has(a.opportunity_id), false, "同一机会存在两个有效分配");
    activeByOpp.set(a.opportunity_id, a);
  }

  // 改排记录可追溯
  const replans = await get("/replans");
  const entry = replans.body.find((r) => r.trigger_kind === "emergency_displacement");
  assert.ok(entry);
  assert.deepEqual(entry.affected_orders, ["ORD-ROUTINE"]);

  // 应急订单解释中可见批准链
  const fireExplain = await get("/orders/ORD-FIRE/explanation");
  assert.ok(fireExplain.body.timeline.some((t) => t.event_type === "emergency_approved"));
});

test("非 emergency 订单不能发起应急插单", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenRoutine(post);
  await post("/orders", {
    ref: "ORD-PLAIN", department: "测绘部", requester_ref: "u", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "urgent",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const result = await post("/emergency/insertions", { order_ref: "ORD-PLAIN" });
  assert.equal(result.status, 409);
});
