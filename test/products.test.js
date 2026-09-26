
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet, sha256 } = require("./helpers");

async function seedImaged(post, get, expectedShards = 2) {
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31] });
  await post("/opportunities", {
    spacecraft_ref: "PIESAT-2-13", window_start: "2026-09-27T02:00:00Z", window_end: "2026-09-27T02:10:00Z",
    bbox: [109.5, 29.5, 111.5, 31.5], supported_modes: ["optical_hr"], energy_cost: 1, storage_cost: 1,
  });
  await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘成果库",
  });
  await post("/orders/ORD-A/subscriptions", { subscriber: "测绘成果库值班员" });
  const run = await post("/plan-runs", {});
  const frozen = await post(`/plan-runs/${run.body.id}/freeze`, {});
  const assignment = frozen.body.assignments[0];
  await post(`/assignments/${assignment.id}/receipts`, {
    source_ref: "PIESAT-2-13", source_sequence: 1, result: "imaged",
    occurred_at: "2026-09-27T02:05:00Z", received_at: "2026-09-27T02:30:00Z",
    expected_shards: expectedShards,
  });
  return assignment;
}

test("分片按校验摘要汇聚：缺片产生 assembling 版本并通知订阅方", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedImaged(post, get, 2);

  await post(`/assignments/${assignment.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("shard-0"), size_bytes: 100,
    downlinked_at: "2026-09-27T03:00:00Z",
  });
  const partial = await post(`/assignments/${assignment.id}/assemble`, {});
  assert.equal(partial.body.product.status, "assembling");
  assert.deepEqual(partial.body.missing_shards, [1]);
  assert.equal(partial.body.product.version, 1);

  const notifications = await get("/orders/ORD-A/notifications");
  assert.ok(notifications.body.some((n) => n.kind === "shard_missing"));
  assert.ok(notifications.body.some((n) => n.kind === "shard_arrived"));

  // 缺片不能交付
  const blocked = await post("/products/PRD-ORD-A/versions/1/deliver", {});
  assert.equal(blocked.status, 409);
});

test("分片补齐后汇聚为完整新版本，交付并通知", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedImaged(post, get, 2);

  await post(`/assignments/${assignment.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("shard-0"), size_bytes: 100,
  });
  const v1 = await post(`/assignments/${assignment.id}/assemble`, {});
  assert.equal(v1.body.product.status, "assembling");

  await post(`/assignments/${assignment.id}/shards`, {
    shard_ref: "S1", seq: 1, checksum_sha256: sha256("shard-1"), size_bytes: 120,
  });
  const v2 = await post(`/assignments/${assignment.id}/assemble`, {});
  assert.equal(v2.body.product.status, "complete");
  assert.equal(v2.body.product.version, 2);
  assert.equal(v2.body.product.manifest.length, 2);
  assert.equal(v2.body.product.manifest_digest.length, 64);
  // v1 仍为 assembling，历史版本保留
  const v1Fetched = await get("/products/PRD-ORD-A/versions/1");
  assert.equal(v1Fetched.body.status, "assembling");

  const delivery = await post("/products/PRD-ORD-A/versions/2/deliver", {});
  assert.equal(delivery.status, 201);
  const notifications = await get("/orders/ORD-A/notifications");
  assert.ok(notifications.body.some((n) => n.kind === "delivered" && n.version === 2));
  const order = await get("/orders/ORD-A");
  assert.equal(order.body.status, "fulfilled");
});

test("相同分片重复上报且摘要一致时幂等；摘要不同被拒绝", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedImaged(post, get, 1);
  const payload = { shard_ref: "S0", seq: 0, checksum_sha256: sha256("shard-0"), size_bytes: 100 };
  const first = await post(`/assignments/${assignment.id}/shards`, payload);
  assert.equal(first.body.deduplicated, false);
  const again = await post(`/assignments/${assignment.id}/shards`, payload);
  assert.equal(again.status, 201);
  assert.equal(again.body.deduplicated, true);
  const tampered = await post(`/assignments/${assignment.id}/shards`, {
    ...payload, checksum_sha256: sha256("different"),
  });
  assert.equal(tampered.status, 409);
});

test("产品重处理与撤回都向订阅方产生可追踪状态，撤回联动召回交付", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  const assignment = await seedImaged(post, get, 1);
  await post(`/assignments/${assignment.id}/shards`, {
    shard_ref: "S0", seq: 0, checksum_sha256: sha256("shard-0"), size_bytes: 100,
  });
  const assembled = await post(`/assignments/${assignment.id}/assemble`, {});
  assert.equal(assembled.body.product.status, "complete");
  await post("/products/PRD-ORD-A/versions/1/deliver", {});

  const reprocessed = await post("/products/PRD-ORD-A/versions/1/reprocess", { reason: "定位精度复核" });
  assert.equal(reprocessed.body.status, "reprocessing");

  // 重处理完成：再次汇聚相同分片清单命中同一版本（manifest 摘要相同，幂等），状态回到 complete
  const reassembled = await post(`/assignments/${assignment.id}/assemble`, {});
  assert.equal(reassembled.body.product.version, 1);
  assert.equal(reassembled.body.product.status, "complete");

  const withdrawn = await post("/products/PRD-ORD-A/versions/1/withdraw", { reason: "几何校正错误" });
  assert.equal(withdrawn.body.status, "withdrawn");
  const notifications = await get("/orders/ORD-A/notifications");
  assert.ok(notifications.body.some((n) => n.kind === "reprocessing"));
  assert.ok(notifications.body.some((n) => n.kind === "withdrawn"));

  const deliveries = await get("/orders/ORD-A/deliveries");
  assert.equal(deliveries.body[0].status, "recalled");
  assert.equal(deliveries.body[0].recall_reason, "几何校正错误");

  // 已撤回版本不能再重处理
  const again = await post("/products/PRD-ORD-A/versions/1/reprocess", {});
  assert.equal(again.status, 409);
});
