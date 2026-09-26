
const assert = require("node:assert/strict");
const test = require("node:test");
const { setupContext, seedFleet } = require("./helpers");

test("订单统一登记全部要素，并校验必填字段", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  assert.equal((await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" })).status, 201);
  assert.equal((await post("/targets", {
    ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31], scope_codes: ["S-MAP"],
  })).status, 201);

  const created = await post("/orders", {
    ref: "ORD-MAP-1",
    department: "测绘部",
    requester_ref: "USER-7",
    target_ref: "TGT-A",
    scope_code: "S-MAP",
    imaging_mode: "optical_hr",
    timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z",
    window_end: "2026-09-29T00:00:00Z",
    deliverable: "测绘成果库",
    usage_boundary: "仅用于基础测绘更新，不得对外分发",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.imaging_mode, "optical_hr");
  assert.equal(created.body.deliverable, "测绘成果库");
  assert.equal(created.body.usage_boundary, "仅用于基础测绘更新，不得对外分发");
  assert.equal(created.body.timeliness, "routine");
  assert.equal(created.body.target.ref, "TGT-A");

  const missing = await post("/orders", { ref: "ORD-X", department: "测绘部" });
  assert.equal(missing.status, 400);
  const badTime = await post("/orders", {
    ref: "ORD-Y", department: "测绘部", requester_ref: "u", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr",
    window_start: "not-a-time", window_end: "2026-09-29T00:00:00Z", deliverable: "d",
  });
  assert.equal(badTime.status, 400);
});

test("不同部门以不同名称（别名）重复下单：提示重复但不自动合并", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/scopes", { code: "S-EMG", owner_dept: "应急部" });
  await post("/targets", {
    ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31],
    aliases: ["河口断面"], scope_codes: ["S-MAP", "S-EMG"],
  });

  const first = await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr", timeliness: "routine",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  assert.equal(first.status, 201);

  // 应急部用别名“河口断面”下单同一目标
  const second = await post("/orders", {
    ref: "ORD-B", department: "应急部", requester_ref: "u2", target_name: "河口断面",
    scope_code: "S-EMG", imaging_mode: "optical_hr", timeliness: "emergency",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-27T00:00:00Z", deliverable: "应急席",
  });
  assert.equal(second.status, 201);
  const flag = second.body.duplicate_suggestions.find((f) => f.order_ref === "ORD-A");
  assert.ok(flag, "必须提示与 ORD-A 重复");
  assert.equal(flag.overlap_kind, "same_target");
  assert.equal(flag.sharing_blocked, true);
  assert.equal(flag.sharing_allowed, false);
  assert.equal(flag.merge_recommended, false);

  // 跨授权范围禁止合并/共享
  const mergeBlocked = await post("/orders/ORD-B/merge", { other_ref: "ORD-A" });
  assert.equal(mergeBlocked.status, 409);
  assert.equal(mergeBlocked.body.details?.code, "authorization_scope_mismatch");
});

test("同授权范围重叠订单提示合并，确认后被并订单挂到主订单", async (context) => {
  const { post, get, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/targets", { ref: "TGT-A", name: "河口", bbox: [110, 30, 111, 31], aliases: ["河口断面"] });
  await post("/targets", { ref: "TGT-C", name: "河湾", bbox: [110.2, 30.2, 110.8, 30.8] });

  const a = await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  assert.equal(a.status, 201);
  // 几何重叠的相邻目标，同部门同授权
  const c = await post("/orders", {
    ref: "ORD-C", department: "测绘部", requester_ref: "u2", target_ref: "TGT-C",
    scope_code: "S-MAP", imaging_mode: "optical_hr",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  assert.equal(c.status, 201);
  const geomFlag = c.body.duplicate_suggestions.find((f) => f.order_ref === "ORD-A");
  assert.ok(geomFlag);
  assert.equal(geomFlag.overlap_kind, "geometry");
  assert.equal(geomFlag.sharing_allowed, true);

  const merged = await post("/orders/ORD-A/merge", { other_ref: "ORD-C" });
  assert.equal(merged.status, 201);
  assert.equal(merged.body.merged_order.status, "cancelled");
  const fetched = await get("/orders/ORD-C");
  assert.equal(fetched.body.status, "cancelled");
});

test("几何重叠但授权范围不同：只提示，不共享", async (context) => {
  const { post, close } = await setupContext();
  context.after(close);
  await seedFleet(post);
  await post("/scopes", { code: "S-MAP", owner_dept: "测绘部" });
  await post("/scopes", { code: "S-MIL", owner_dept: "专项授权部门" });
  await post("/targets", { ref: "TGT-A", name: "甲区", bbox: [110, 30, 111, 31] });
  await post("/targets", { ref: "TGT-B", name: "乙区", bbox: [110.5, 30.5, 111.5, 31.5] });
  await post("/orders", {
    ref: "ORD-A", department: "测绘部", requester_ref: "u1", target_ref: "TGT-A",
    scope_code: "S-MAP", imaging_mode: "optical_hr",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "测绘库",
  });
  const blocked = await post("/orders", {
    ref: "ORD-B", department: "专项授权部门", requester_ref: "u9", target_ref: "TGT-B",
    scope_code: "S-MIL", imaging_mode: "optical_hr",
    window_start: "2026-09-26T00:00:00Z", window_end: "2026-09-29T00:00:00Z", deliverable: "专席",
  });
  const flag = blocked.body.duplicate_suggestions.find((f) => f.order_ref === "ORD-A");
  assert.ok(flag);
  assert.equal(flag.overlap_kind, "geometry");
  assert.equal(flag.sharing_blocked, true);
  assert.equal(flag.merge_recommended, false);
});
