
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet, sha256 } = require("./helpers");

async function seedFrozenPlan(post, options = {}) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"],
    energy_cost: 1, storage_cost: 1, receipt_due_after_minutes: 60,
  });
  await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  await post("/orders", {
    ref: "ORD-B", department: "测绘部", requester_ref: "u2", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const run = await post("/plan-runs", {});
  // 只有一个机会：ORB-A 先得，ORD-B 无选中
  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  const assignment = frozen.body.assignments[0];
  // 给 ORD-B 增加 14 星机会并再排一次
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-14", window_start: "2026-09-28T02:00:00Z", window_end: "2026-09-28T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  const run2 = await post("/plan-runs", { order_refs: ["ORD-B"] });
  await post(`/plan-runs/${run2.body.id}/freeze`, {});
  return assignment;
}

test("卫星不可用：仅依赖该卫星的订单进入重排，其他订单不动", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenPlan(post);
  const beforeA = await get("/orders/ORD-A");
  assert.equal(beforeA.body.status, "scheduled");

  // 13 星不可用，新增 15 星机会使 ORD-A 可重排
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-28T06:00:00Z", window_end: "2026-09-28T06:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  const result = await post("/spacecraft/PIESAT-2-13/unavailable", { reason: "姿控异常" });
  assert.equal(result.body.trigger_kind, "spacecraft_unavailable");
  assert.deepEqual(result.body.affected_orders, ["ORD-A"]);
  assert.ok(result.body.new_assignments.some((a) => a.spacecraft_ref === "PIESAT-2-15"));

  // ORD-B 不依赖 13 星，分配保持 scheduled
  const bAssignments = await get("/assignments?order_ref=ORD-B");
  assert.ok(bAssignments.body.some((a) => a.state === "scheduled"));
  assert.equal(result.body.old_assignments[0].spacecraft_ref, "PIESAT-2-13");
});

test("机会预报修订：仅使用该机会的订单重排，修订后新机会可被重新选中", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenPlan(post);
  const assignments = await get("/assignments?order_ref=ORD-A");
  const oldAssignment = assignments.body.find((a) => a.state === "scheduled");
  const oldOpportunity = oldAssignment.opportunity_id;

  // 修订：时间整体推迟到 15 星同时段之外，并改由 15 星承接另一个新机会
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-28T09:00:00Z", window_end: "2026-09-28T09:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  const revised = await post(`/opportunities/${oldOpportunity}/revise`, {
    window_start: "2026-10-02T02:00:00Z", window_end: "2026-10-02T02:10:00Z",
  });
  assert.equal(revised.body.trigger_kind, "opportunity_revised");
  assert.deepEqual(revised.body.affected_orders, ["ORD-A"]);
  // 修订后的机会超出 ORD-A 窗口（09-29 截止），重排应选中 15 星新机会
  assert.ok(revised.body.new_assignments.some((a) => a.spacecraft_ref === "PIESAT-2-15"));
  const opps = await get("/opportunities");
  assert.ok(opps.body.some((o) => o.id === oldOpportunity && o.status === "revised"));
});

test("回执逾期未到触发重排；迟到回执只登记事实，不撤销既成改排", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenPlan(post);
  // 提供 15 星替代机会
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-15", window_start: "2026-09-28T06:00:00Z", window_end: "2026-09-28T06:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  // 监测时刻晚于 13 星机会窗口结束 + 60 分钟
  const detection = await post("/receipts/detect-late", { now: "2026-09-27T04:00:00Z" });
  assert.equal(detection.body.overdue.length, 1);
  assert.equal(detection.body.replans[0].trigger_kind, "receipt_late");
  assert.deepEqual(detection.body.replans[0].affected_orders, ["ORD-A"]);

  // 迟到的成功回执：只补充事实
  const oldAssignments = await get("/assignments?order_ref=ORD-A");
  const failedOne = oldAssignments.body.find((a) => a.state === "failed");
  const late = await post(`/assignments/${failedOne.id}/receipts`, {
    source_ref: "PIESAT-2-13", source_sequence: 1, result: "imaged",
    occurred_at: "2026-09-27T02:05:00Z", received_at: "2026-09-27T05:00:00Z",
  });
  assert.equal(late.body.effect, "late_after_replan");
  assert.equal(late.body.late, true);
  const explain = await get("/orders/ORD-A/explanation");
  assert.ok(explain.body.timeline.some((t) => t.event_type === "late_receipt_after_replan"));
});

test("已交付数据产品继续引用原计划，后续改排不改变已交付版本", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await seedFrozenPlan(post);

  // 完成 ORD-A 的成像、汇聚、交付
  const assignmentA = (await get("/assignments?order_ref=ORD-A")).body.find((a) => a.state === "scheduled");
  await post(`/assignments/${assignmentA.id}/receipts`, {
    source_ref: "PIESAT-2-13", source_sequence: 1, result: "imaged",
    occurred_at: "2026-09-27T02:05:00Z", received_at: "2026-09-27T02:30:00Z",
    expected_shards: 1,
  });
  await post(`/assignments/${assignmentA.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("shard-0"), size_bytes: 100,
    downlinked_at: "2026-09-27T03:00:00Z",
  });
  const assembled = await post(`/assignments/${assignmentA.id}/assemble`, {});
  const productRef = assembled.body.product.product_ref;
  await post(`/products/${productRef}/versions/1/deliver`, {});

  // 之后 13 星不可用：ORD-A 已 fulfilled，不受影响；产品仍指向原分配与原计划
  await post("/spacecraft/PIESAT-2-13/unavailable", { reason: "事后异常" });
  const products = await get("/products?order_ref=ORD-A");
  assert.equal(products.body.length, 1);
  assert.equal(products.body[0].assignment_id, assignmentA.id);
  assert.equal(products.body[0].plan_run_id, assignmentA.plan_run_id);
  const deliveries = await get("/orders/ORD-A/deliveries");
  assert.equal(deliveries.body.length, 1);
  assert.equal(deliveries.body[0].status, "delivered");
  const orderA = await get("/orders/ORD-A");
  assert.equal(orderA.body.status, "fulfilled");
});
