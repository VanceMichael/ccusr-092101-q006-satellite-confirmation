
const crypto = require("node:crypto");
const { newId, nowIso } = require("./util");

// 外部事实（卫星状态、机会预报、执行回执、分片到达）必须携带来源与序列号，
// 同一 (source_ref, source_sequence) 只接受一次，保留来源系统对事实的责任边界。
function acceptInboundEvent(db, { source_ref, source_sequence, event_kind, payload }) {
  if (!source_ref || !Number.isInteger(source_sequence)) {
    const error = new Error("外部事件必须携带 source_ref 与整数 source_sequence");
    error.status = 400;
    error.code = "missing_source";
    throw error;
  }
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  const existing = db
    .prepare("SELECT payload_hash FROM inbound_event WHERE source_ref = ? AND source_sequence = ?")
    .get(source_ref, source_sequence);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      const error = new Error("同一来源序列号对应不同载荷，拒绝覆盖");
      error.status = 409;
      error.code = "source_sequence_conflict";
      throw error;
    }
    return { duplicate: true };
  }
  db.prepare(
    `INSERT INTO inbound_event(source_ref, source_sequence, event_kind, payload_hash, accepted_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(source_ref, source_sequence, event_kind, payloadHash, nowIso());
  return { duplicate: false };
}

// 订单事件时间线，只追加
function recordOrderEvent(db, orderId, kind, detail = {}, actorRef = null) {
  db.prepare(
    `INSERT INTO order_event(order_id, kind, detail, actor_ref, occurred_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(orderId, kind, JSON.stringify(detail), actorRef, nowIso());
}

function getOrderTimeline(db, orderId) {
  return db
    .prepare("SELECT kind, detail, actor_ref, occurred_at FROM order_event WHERE order_id = ? ORDER BY event_id")
    .all(orderId)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
}

function nextNotificationId() {
  return newId("ntf");
}

module.exports = { acceptInboundEvent, recordOrderEvent, getOrderTimeline, nextNotificationId };
