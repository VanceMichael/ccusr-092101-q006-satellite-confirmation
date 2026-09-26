
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, parseTime, sha256Hex } = require("./util");
const planning = require("./planning");
const { addTimeline, notify } = require("./events");

// ---------- 分片 ----------

// 登记下传分片（按校验摘要）；同一分配同一分片引用重复上报且摘要一致时幂等
function registerShard(assignmentRef, input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const assignment = planning.getAssignment(String(assignmentRef));
  const shardRef = String(input.shard_ref || "");
  const checksum = String(input.checksum_sha256 || "");
  assert(shardRef, "shard_ref 必填");
  assert(/^[0-9a-f]{64}$/i.test(checksum), "checksum_sha256 必须是 64 位十六进制摘要");
  const seq = Number(input.seq);
  assert(Number.isInteger(seq) && seq >= 0, "seq 必须是非负整数");
  const downlinkedAt = input.downlinked_at ? parseTime(input.downlinked_at, "downlinked_at") : nowIso();

  const db = getDatabase();
  const existing = db.prepare(
    "SELECT * FROM data_shards WHERE assignment_id = ? AND shard_ref = ?",
  ).get(assignment.id, shardRef);
  if (existing) {
    if (existing.checksum_sha256 !== checksum.toLowerCase()) {
      throw new ConflictError(`分片 ${shardRef} 已存在但校验摘要不同`, {
        existing_checksum: existing.checksum_sha256,
      });
    }
    return { shard: existing, deduplicated: true };
  }
  const id = newId("shd");
  db.prepare(
    `INSERT INTO data_shards(id, assignment_id, shard_ref, seq, checksum_sha256, size_bytes, downlinked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, assignment.id, shardRef, seq, checksum.toLowerCase(), Number(input.size_bytes ?? 0), downlinkedAt);
  addTimeline(assignment.order_id, "shard_downlinked", {
    assignment_ref: assignment.id, shard_ref: shardRef, seq, checksum_sha256: checksum.toLowerCase(),
  });
  notify(assignment.order_id, "shard_arrived", { shard_ref: shardRef, seq, assignment_ref: assignment.id });
  return { shard: db.prepare("SELECT * FROM data_shards WHERE id = ?").get(id), deduplicated: false };
}

function listShards(assignmentRef) {
  const assignment = planning.getAssignment(String(assignmentRef));
  return getDatabase()
    .prepare("SELECT * FROM data_shards WHERE assignment_id = ? ORDER BY seq, shard_ref")
    .all(assignment.id);
}

// ---------- 产品汇聚 ----------

function expectedShardsFor(assignmentId) {
  const row = getDatabase().prepare(
    "SELECT expected_shards FROM execution_receipts WHERE assignment_id = ? ORDER BY received_at DESC LIMIT 1",
  ).get(assignmentId);
  return row ? row.expected_shards : 0;
}

function buildManifest(assignmentId) {
  const db = getDatabase();
  const shards = db.prepare(
    "SELECT shard_ref, seq, checksum_sha256 FROM data_shards WHERE assignment_id = ? AND status = 'downlinked' ORDER BY seq, shard_ref",
  ).all(assignmentId);
  const expected = expectedShardsFor(assignmentId);
  const presentSeqs = new Set(shards.map((s) => s.seq));
  const missing = [];
  for (let seq = 0; seq < expected; seq += 1) {
    if (!presentSeqs.has(seq)) missing.push(seq);
  }
  const manifest = shards.map((s) => ({ shard_ref: s.shard_ref, seq: s.seq, sha256: s.checksum_sha256 }));
  const digest = sha256Hex(JSON.stringify(manifest));
  return { manifest, digest, missing, expected };
}

// 汇聚：把某分配已下传的分片按校验摘要聚成明确版本
function assembleProduct(assignmentRef) {
  const assignment = planning.getAssignment(String(assignmentRef));
  const db = getDatabase();
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(assignment.order_id);
  const { manifest, digest, missing, expected } = buildManifest(assignment.id);
  if (manifest.length === 0) throw new ConflictError("该分配尚未下传任何分片，无法汇聚");

  const productRef = `PRD-${order.ref}`;
  const status = missing.length === 0 ? "complete" : "assembling";

  // 相同清单摘要 → 同一版本（幂等）；不同摘要 → 新版本
  const existing = db.prepare(
    "SELECT * FROM product_versions WHERE product_ref = ? AND manifest_digest = ?",
  ).get(productRef, digest);
  let versionRow;
  let created = false;
  if (existing) {
    versionRow = existing;
    if (["assembling", "reprocessing"].includes(existing.status)) {
      const nextStatus = status === "complete" ? "complete" : "assembling";
      db.prepare("UPDATE product_versions SET status = ?, missing_shards = ?, updated_at = ? WHERE id = ?")
        .run(nextStatus, JSON.stringify(missing), nowIso(), existing.id);
      versionRow = db.prepare("SELECT * FROM product_versions WHERE id = ?").get(existing.id);
      if (nextStatus === "complete") {
        notify(order.id, "version_assembled", { product_ref: productRef, version: versionRow.version, manifest_digest: digest });
        addTimeline(order.id, "product_assembled", {
          product_ref: productRef, version: versionRow.version,
          reprocessed: existing.status === "reprocessing",
        });
      }
    }
  } else {
    const maxVersion = db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS v FROM product_versions WHERE product_ref = ?",
    ).get(productRef).v;
    const id = newId("pv");
    db.prepare(
      `INSERT INTO product_versions
         (id, product_ref, version, order_id, assignment_id, plan_run_id, status, missing_shards, manifest, manifest_digest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, productRef, maxVersion + 1, order.id, assignment.id, assignment.plan_run_id,
      status, JSON.stringify(missing), JSON.stringify(manifest), digest, nowIso(), nowIso(),
    );
    versionRow = db.prepare("SELECT * FROM product_versions WHERE id = ?").get(id);
    created = true;
    if (status === "complete") {
      notify(order.id, "version_assembled", { product_ref: productRef, version: versionRow.version, manifest_digest: digest });
      addTimeline(order.id, "product_assembled", { product_ref: productRef, version: versionRow.version });
    } else {
      notify(order.id, "shard_missing", {
        product_ref: productRef, version: versionRow.version, missing_shards: missing, expected_shards: expected,
      });
      addTimeline(order.id, "product_missing_shards", {
        product_ref: productRef, version: versionRow.version, missing_shards: missing,
      });
    }
  }
  return { product: hydrateProduct(versionRow), created, missing_shards: missing, expected_shards: expected };
}

function hydrateProduct(row) {
  return {
    id: row.id,
    product_ref: row.product_ref,
    version: row.version,
    order_id: row.order_id,
    assignment_id: row.assignment_id,   // 产品永久引用原计划分配
    plan_run_id: row.plan_run_id,       // 与冻结计划
    status: row.status,
    missing_shards: JSON.parse(row.missing_shards),
    manifest: JSON.parse(row.manifest),
    manifest_digest: row.manifest_digest,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getProductVersion(productRef, version) {
  const row = getDatabase().prepare(
    "SELECT * FROM product_versions WHERE product_ref = ? AND version = ?",
  ).get(productRef, Number(version));
  if (!row) throw new NotFoundError(`产品版本不存在：${productRef} v${version}`);
  return hydrateProduct(row);
}

function listProducts(filter = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM product_versions";
  const params = [];
  if (filter.order_ref) {
    const order = require("./orders").getOrder(filter.order_ref);
    sql += " WHERE order_id = ?";
    params.push(order.id);
  }
  sql += " ORDER BY product_ref, version";
  return db.prepare(sql).all(...params).map(hydrateProduct);
}

// ---------- 重处理与撤回 ----------

function reprocessProduct(productRef, version, reason = "") {
  const db = getDatabase();
  const product = getProductVersion(productRef, version);
  if (product.status === "withdrawn") throw new ConflictError("已撤回的版本不能重处理");
  db.prepare("UPDATE product_versions SET status = 'reprocessing', updated_at = ? WHERE id = ?")
    .run(nowIso(), product.id);
  notify(product.order_id, "reprocessing", { product_ref: productRef, version: product.version, reason });
  addTimeline(product.order_id, "product_reprocessing", { product_ref: productRef, version: product.version, reason });
  return getProductVersion(productRef, version);
}

function withdrawProduct(productRef, version, reason = "") {
  const db = getDatabase();
  const product = getProductVersion(productRef, version);
  if (product.status === "withdrawn") throw new ConflictError("该版本已撤回");
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE product_versions SET status = 'withdrawn', updated_at = ? WHERE id = ?")
      .run(nowIso(), product.id);
    db.prepare(
      "UPDATE deliveries SET status = 'recalled', recall_reason = ? WHERE product_version_id = ? AND status = 'delivered'",
    ).run(reason, product.id);
    db.prepare("UPDATE data_shards SET status = 'withdrawn' WHERE assignment_id = ?").run(product.assignment_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  notify(product.order_id, "withdrawn", { product_ref: productRef, version: product.version, reason });
  addTimeline(product.order_id, "product_withdrawn", { product_ref: productRef, version: product.version, reason });
  return getProductVersion(productRef, version);
}

// ---------- 交付 ----------

function deliverProduct(productRef, version) {
  const db = getDatabase();
  const product = getProductVersion(productRef, version);
  if (product.status !== "complete") {
    throw new ConflictError(`产品 ${productRef} v${version} 状态 ${product.status}，仅完整版本可交付`);
  }
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(product.order_id);
  const existing = db.prepare(
    "SELECT * FROM deliveries WHERE order_id = ? AND product_version_id = ?",
  ).get(order.id, product.id);
  if (existing) return { delivery: existing, deduplicated: true };

  const id = newId("dlv");
  db.prepare(
    `INSERT INTO deliveries(id, order_id, product_version_id, deliverable, delivered_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, order.id, product.id, order.deliverable, nowIso());
  db.prepare("UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE id = ?").run(nowIso(), order.id);
  notify(order.id, "delivered", {
    product_ref: productRef, version: product.version, deliverable: order.deliverable,
  });
  addTimeline(order.id, "product_delivered", {
    product_ref: productRef, version: product.version, deliverable: order.deliverable,
    plan_run_id: product.plan_run_id, assignment_id: product.assignment_id,
  });
  return { delivery: db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id), deduplicated: false };
}

function listDeliveries(orderRef) {
  const order = require("./orders").getOrder(orderRef);
  return getDatabase().prepare("SELECT * FROM deliveries WHERE order_id = ? ORDER BY delivered_at").all(order.id);
}

// ---------- 订阅 ----------

function subscribe(orderRef, subscriber) {
  const order = require("./orders").getOrder(orderRef);
  const db = getDatabase();
  const existing = db.prepare(
    "SELECT * FROM subscriptions WHERE order_id = ? AND subscriber = ?",
  ).get(order.id, String(subscriber));
  if (existing) return { subscription: existing, deduplicated: true };
  const id = newId("sub");
  db.prepare("INSERT INTO subscriptions(id, order_id, subscriber, created_at) VALUES (?, ?, ?, ?)")
    .run(id, order.id, String(subscriber), nowIso());
  return { subscription: db.prepare("SELECT * FROM subscriptions WHERE id = ?").get(id), deduplicated: false };
}

module.exports = {
  registerShard,
  listShards,
  assembleProduct,
  getProductVersion,
  listProducts,
  reprocessProduct,
  withdrawProduct,
  deliverProduct,
  listDeliveries,
  subscribe,
};
