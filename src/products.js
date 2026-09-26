
const { inTransaction } = require("./db");
const { acceptInboundEvent, recordOrderEvent, nextNotificationId } = require("./events");
const { getOrder, assertScopeGranted } = require("./orders");
const { nowIso, newId, httpError, requireFields, sha256OfParts } = require("./util");

const RECEIVING_STATUSES = new Set(["scheduled", "executing", "receipt_confirmed"]);

// ---- 订阅 ----

function subscribe(db, input) {
  requireFields(input, ["subscriber_ref", "order_id"]);
  const order = getOrder(db, input.order_id);
  assertScopeGranted(db, input.subscriber_ref, order.data_scope);
  db.prepare(
    `INSERT OR IGNORE INTO product_subscription(subscriber_ref, product_id, order_id, data_scope, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(input.subscriber_ref, order.order_id, order.order_id, order.data_scope, nowIso());
  return { subscriber_ref: input.subscriber_ref, product_id: order.order_id, data_scope: order.data_scope };
}

function subscribersOf(db, orderId) {
  return db.prepare("SELECT subscriber_ref FROM product_subscription WHERE order_id = ?").all(orderId)
    .map((row) => row.subscriber_ref);
}

// 通知去重：同产品/版本/订阅方/类型只有一条可追踪记录；生成即视为已投送
function emitNotification(db, { product_id, version, subscriber_refs, kind, detail }) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO product_notification(notification_id, product_id, version, subscriber_ref,
        kind, status, detail, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`
  );
  let created = 0;
  for (const subscriberRef of subscriber_refs) {
    const result = insert.run(nextNotificationId(), product_id, version, subscriberRef, kind, JSON.stringify(detail ?? {}), nowIso());
    created += result.changes ?? 0;
  }
  return created;
}

// ---- 分片接收与版本汇聚 ----

function receiveShard(db, input, source = {}) {
  requireFields(input, ["allocation_id", "shard_index", "checksum_sha256", "size_mb"]);
  if (!Number.isInteger(input.shard_index) || input.shard_index < 0) {
    throw httpError(400, "invalid_shard_index", "shard_index 必须是非负整数");
  }
  if (!/^[a-f0-9]{64}$/i.test(input.checksum_sha256)) {
    throw httpError(400, "invalid_checksum", "checksum_sha256 必须是 64 位十六进制摘要");
  }
  const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(input.allocation_id);
  if (!allocation) throw httpError(404, "allocation_not_found", "分配不存在");
  if (!RECEIVING_STATUSES.has(allocation.status)) {
    throw httpError(409, "allocation_not_receiving", `分配状态 ${allocation.status}，不能接收分片`);
  }
  const order = getOrder(db, allocation.order_id);

  return inTransaction(db, () => {
    if (source.source_ref) acceptInboundEvent(db, { ...source, event_kind: "data_shard", payload: input });

    // 期望分片数可在分配上预知，也允许随首片声明
    let expectedShards = allocation.expected_shards;
    if (!expectedShards && Number.isInteger(input.expected_shards) && input.expected_shards > 0) {
      expectedShards = input.expected_shards;
      db.prepare("UPDATE plan_allocation SET expected_shards = ? WHERE allocation_id = ?")
        .run(expectedShards, allocation.allocation_id);
    }
    if (expectedShards && input.shard_index >= expectedShards) {
      throw httpError(422, "shard_index_out_of_range", `分片序号 ${input.shard_index} 超出预期总数 ${expectedShards}`);
    }

    // 未显式指定版本时，归入该分配下的最新版本（重处理后即新版本）
    const version = input.product_version || latestVersion(db, allocation.allocation_id) || 1;
    const product = ensureProductVersion(db, { order, allocation, version });

    const duplicate = db.prepare(
      "SELECT checksum_sha256 FROM data_shard WHERE allocation_id = ? AND shard_index = ? AND product_version = ?"
    ).get(allocation.allocation_id, input.shard_index, version);
    if (duplicate) {
      if (duplicate.checksum_sha256.toLowerCase() !== input.checksum_sha256.toLowerCase()) {
        throw httpError(409, "shard_checksum_conflict",
          `分片 ${input.shard_index} 已以不同摘要到达，疑似重传错误，需走重处理流程`,
          { existing: duplicate.checksum_sha256, received: input.checksum_sha256 });
      }
      return { product_id: order.order_id, version, shard_index: input.shard_index, duplicate: true, product: hydrateProduct(product) };
    }

    db.prepare(
      `INSERT INTO data_shard(shard_id, allocation_id, order_id, product_version, shard_index,
          checksum_sha256, size_mb, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId("shd"), allocation.allocation_id, order.order_id, version, input.shard_index,
      input.checksum_sha256.toLowerCase(), input.size_mb, nowIso());

    return evaluateProduct(db, { order, allocation, product, expectedShards });
  });
}

function ensureProductVersion(db, { order, allocation, version }) {
  const existing = db.prepare(
    "SELECT * FROM data_product_version WHERE product_id = ? AND version = ?"
  ).get(order.order_id, version);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO data_product_version(product_id, version, order_id, allocation_id, source_plan_id,
        spacecraft_ref, opportunity_id, status, shard_checksums, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', '{}', ?)`
  ).run(order.order_id, version, order.order_id, allocation.allocation_id, allocation.plan_id,
    allocation.spacecraft_ref, allocation.opportunity_id, nowIso());
  recordOrderEvent(db, order.order_id, "product_version_opened", {
    product_id: order.order_id,
    version,
    allocation_id: allocation.allocation_id,
    source_plan_id: allocation.plan_id,
  });
  return db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND version = ?").get(order.order_id, version);
}

// 按有序分片校验摘要汇聚；缺片产生可追踪通知
function evaluateProduct(db, { order, allocation, product, expectedShards }) {
  const shards = db.prepare(
    "SELECT shard_index, checksum_sha256 FROM data_shard WHERE allocation_id = ? AND product_version = ? ORDER BY shard_index"
  ).all(allocation.allocation_id, product.version);
  const checksumMap = {};
  for (const shard of shards) checksumMap[shard.shard_index] = shard.checksum_sha256;

  let missing = [];
  if (expectedShards) {
    for (let index = 0; index < expectedShards; index += 1) {
      if (!checksumMap[index]) missing.push(index);
    }
  }
  const previousMissing = new Set(JSON.parse(product.missing_indices));
  const newMissing = missing.filter((index) => !previousMissing.has(index));

  db.prepare("UPDATE data_product_version SET shard_checksums = ?, missing_indices = ? WHERE product_id = ? AND version = ?")
    .run(JSON.stringify(checksumMap), JSON.stringify(missing), product.product_id, product.version);

  const subscribers = subscribersOf(db, order.order_id);
  if (newMissing.length > 0) {
    emitNotification(db, {
      product_id: product.product_id,
      version: product.version,
      subscriber_refs: subscribers,
      kind: "shard_missing",
      detail: { missing_indices: newMissing, expected_shards: expectedShards, allocation_id: allocation.allocation_id },
    });
    recordOrderEvent(db, product.product_id, "shards_missing", {
      version: product.version, missing_indices: newMissing,
    });
  }

  const refreshed = db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND version = ?")
    .get(product.product_id, product.version);

  if (expectedShards && missing.length === 0 && refreshed.status === "incomplete") {
    return assembleProduct(db, { order, allocation, product: refreshed, checksumMap, expectedShards });
  }
  return {
    product_id: product.product_id,
    version: product.version,
    status: missing.length ? "incomplete" : refreshed.status,
    received_shards: shards.length,
    expected_shards: expectedShards ?? null,
    missing_indices: missing,
  };
}

function assembleProduct(db, { order, allocation, product, checksumMap, expectedShards }) {
  const ordered = Object.keys(checksumMap).map(Number).sort((a, b) => a - b)
    .map((index) => `${index}:${checksumMap[index]}`);
  const aggregate = sha256OfParts([product.product_id, String(product.version), product.processing_recipe, ...ordered]);
  const assembledAt = nowIso();
  db.prepare(
    `UPDATE data_product_version SET status = 'assembled', aggregate_checksum = ?, missing_indices = '[]', assembled_at = ?
     WHERE product_id = ? AND version = ?`
  ).run(aggregate, assembledAt, product.product_id, product.version);
  db.prepare("UPDATE observation_order SET status = 'delivered' WHERE order_id = ?").run(product.product_id);
  if (allocation.status === "executing" || allocation.status === "scheduled") {
    db.prepare("UPDATE plan_allocation SET status = 'receipt_confirmed', receipt_at = COALESCE(receipt_at, ?) WHERE allocation_id = ?")
      .run(assembledAt, allocation.allocation_id);
  }
  const subscribers = subscribersOf(db, product.product_id);
  emitNotification(db, {
    product_id: product.product_id,
    version: product.version,
    subscriber_refs: subscribers,
    kind: "assembled",
    detail: {
      aggregate_checksum: aggregate,
      shard_count: expectedShards,
      source_plan_id: product.source_plan_id,
      spacecraft_ref: product.spacecraft_ref,
      opportunity_id: product.opportunity_id,
    },
  });
  recordOrderEvent(db, product.product_id, "product_assembled", {
    version: product.version,
    aggregate_checksum: aggregate,
    shard_count: expectedShards,
    source_plan_id: product.source_plan_id,
    allocation_id: product.allocation_id,
  });
  return {
    product_id: product.product_id,
    version: product.version,
    status: "assembled",
    aggregate_checksum: aggregate,
    received_shards: expectedShards,
    expected_shards: expectedShards,
    missing_indices: [],
  };
}

// 显式缺片检查：在预计收齐时刻仍未到齐时登记可追踪缺片状态
function detectMissingShards(db, input) {
  requireFields(input, ["allocation_id"]);
  const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(input.allocation_id);
  if (!allocation) throw httpError(404, "allocation_not_found", "分配不存在");
  const expectedShards = Number.isInteger(input.expected_shards) ? input.expected_shards : allocation.expected_shards;
  if (!expectedShards) throw httpError(409, "expected_shards_unknown", "尚不知道预期分片总数，无法判定缺片");

  const version = input.product_version || latestVersion(db, allocation.allocation_id) || 1;
  const order = getOrder(db, allocation.order_id);
  const product = ensureProductVersion(db, { order, allocation, version });
  return inTransaction(db, () => evaluateProduct(db, { order, allocation, product, expectedShards }));
}

// 重处理：基于已汇聚版本开启新版本；旧版本保留为被取代的事实，新版本重新汇聚分片
function reprocess(db, input, actorRef = null) {
  requireFields(input, ["order_id"]);
  const order = getOrder(db, input.order_id);
  const source = input.version
    ? db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND version = ?").get(order.order_id, input.version)
    : db.prepare("SELECT * FROM data_product_version WHERE product_id = ? ORDER BY version DESC LIMIT 1").get(order.order_id);
  if (!source) throw httpError(404, "product_not_found", "订单尚无数据产品版本");
  if (source.status === "withdrawn") throw httpError(409, "product_withdrawn", "撤回版本不能作为重处理来源");

  const recipe = input.processing_recipe || `${source.processing_recipe}+reproc`;
  return inTransaction(db, () => {
    const newVersion = source.version + 1;
    db.prepare(
      `INSERT INTO data_product_version(product_id, version, order_id, allocation_id, source_plan_id,
          spacecraft_ref, opportunity_id, status, processing_recipe, shard_checksums, missing_indices, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'incomplete', ?, '{}', '[]', ?)`
    ).run(order.order_id, newVersion, order.order_id, source.allocation_id, source.source_plan_id,
      source.spacecraft_ref, source.opportunity_id, recipe, nowIso());
    db.prepare("UPDATE data_product_version SET superseded_by_version = ? WHERE product_id = ? AND version = ?")
      .run(newVersion, order.order_id, source.version);

    // 默认沿用来源版本的全部分片重新汇聚；carry_shards=false 时等待重新下传
    if (input.carry_shards !== false) {
      const shards = db.prepare(
        "SELECT shard_index, checksum_sha256, size_mb FROM data_shard WHERE allocation_id = ? AND product_version = ? ORDER BY shard_index"
      ).all(source.allocation_id, source.version);
      const insertShard = db.prepare(
        `INSERT INTO data_shard(shard_id, allocation_id, order_id, product_version, shard_index,
            checksum_sha256, size_mb, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const checksumMap = {};
      for (const shard of shards) {
        insertShard.run(newId("shd"), source.allocation_id, order.order_id, newVersion,
          shard.shard_index, shard.checksum_sha256, shard.size_mb, nowIso());
        checksumMap[shard.shard_index] = shard.checksum_sha256;
      }
      db.prepare("UPDATE data_product_version SET shard_checksums = ? WHERE product_id = ? AND version = ?")
        .run(JSON.stringify(checksumMap), order.order_id, newVersion);

      const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(source.allocation_id);
      const refreshed = db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND version = ?")
        .get(order.order_id, newVersion);
      evaluateProduct(db, { order, allocation, product: refreshed, expectedShards: allocation.expected_shards });
    }

    emitNotification(db, {
      product_id: order.order_id,
      version: newVersion,
      subscriber_refs: subscribersOf(db, order.order_id),
      kind: "reprocessed",
      detail: {
        from_version: source.version,
        reason: input.reason ?? "reprocessing_requested",
        processing_recipe: recipe,
        note: input.note ?? null,
      },
    });
    recordOrderEvent(db, order.order_id, "product_reprocess_requested", {
      from_version: source.version,
      new_version: newVersion,
      processing_recipe: recipe,
      reason: input.reason ?? null,
    }, actorRef);
    return { product_id: order.order_id, new_version: newVersion, supersedes: source.version, status: "incomplete", processing_recipe: recipe };
  });
}

// 撤回：已交付版本作废并通知所有订阅方；已引用原计划的事实保留
function withdraw(db, input, actorRef = null) {
  requireFields(input, ["order_id", "reason"]);
  const order = getOrder(db, input.order_id);
  const product = input.version
    ? db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND version = ?").get(order.order_id, input.version)
    : db.prepare("SELECT * FROM data_product_version WHERE product_id = ? AND status = 'assembled' ORDER BY version DESC LIMIT 1")
        .get(order.order_id);
  if (!product) throw httpError(404, "product_not_found", "没有可撤回的已汇聚版本");

  return inTransaction(db, () => {
    db.prepare("UPDATE data_product_version SET status = 'withdrawn', withdrawn_at = ?, withdraw_reason = ? WHERE product_id = ? AND version = ?")
      .run(nowIso(), input.reason, order.order_id, product.version);
    emitNotification(db, {
      product_id: order.order_id,
      version: product.version,
      subscriber_refs: subscribersOf(db, order.order_id),
      kind: "withdrawn",
      detail: { reason: input.reason, aggregate_checksum: product.aggregate_checksum },
    });
    recordOrderEvent(db, order.order_id, "product_withdrawn", {
      version: product.version,
      reason: input.reason,
      source_plan_id: product.source_plan_id,
    }, actorRef);

    // 可选：撤回后需要重新成像的订单回到重排队列
    let replanning = false;
    if (input.trigger_reimaging) {
      const allocation = db.prepare("SELECT * FROM plan_allocation WHERE allocation_id = ?").get(product.allocation_id);
      const { enterReplanning } = require("./catalog");
      enterReplanning(db, order.order_id, {
        trigger_kind: "receipt_failed",
        trigger_ref: `withdraw:${product.version}`,
        previous_allocation_id: allocation.allocation_id,
      });
      replanning = true;
    }
    return { product_id: order.order_id, version: product.version, status: "withdrawn", replanning };
  });
}

// ---- 查询 ----

function latestVersion(db, allocationId) {
  const row = db.prepare("SELECT MAX(version) AS v FROM data_product_version WHERE allocation_id = ?").get(allocationId);
  return row ? row.v : null;
}

function getProduct(db, productId) {
  const rows = db.prepare("SELECT * FROM data_product_version WHERE product_id = ? ORDER BY version").all(productId);
  if (rows.length === 0) throw httpError(404, "product_not_found", `产品 ${productId} 不存在`);
  return { product_id: productId, versions: rows.map(hydrateProduct) };
}

function hydrateProduct(row) {
  return {
    ...row,
    shard_checksums: JSON.parse(row.shard_checksums),
    missing_indices: JSON.parse(row.missing_indices),
  };
}

function listNotifications(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.subscriber_ref) {
    clauses.push("subscriber_ref = ?");
    params.push(filter.subscriber_ref);
  }
  if (filter.product_id) {
    clauses.push("product_id = ?");
    params.push(filter.product_id);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT * FROM product_notification ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at`;
  return db.prepare(sql).all(...params).map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

function acknowledgeNotification(db, input) {
  requireFields(input, ["notification_id", "subscriber_ref"]);
  const row = db.prepare("SELECT * FROM product_notification WHERE notification_id = ? AND subscriber_ref = ?")
    .get(input.notification_id, input.subscriber_ref);
  if (!row) throw httpError(404, "notification_not_found", "通知不存在或不属于该订阅方");
  db.prepare("UPDATE product_notification SET status = 'acked', acked_at = ? WHERE notification_id = ?")
    .run(nowIso(), input.notification_id);
  return { notification_id: input.notification_id, status: "acked" };
}

module.exports = {
  subscribe,
  receiveShard,
  detectMissingShards,
  reprocess,
  withdraw,
  getProduct,
  listNotifications,
  acknowledgeNotification,
  hydrateProduct,
};
