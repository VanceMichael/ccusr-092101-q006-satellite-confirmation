
const { getDatabase } = require("./db");
const { newId, nowIso } = require("./util");

// 统一登记来源事件，保留来源系统对事实的责任边界（幂等：source_ref + source_sequence）
function recordDomainEvent(event) {
  const db = getDatabase();
  const id = newId("evt");
  db.prepare(
    `INSERT INTO domain_events(id, source_ref, source_sequence, event_kind, payload, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    event.source_ref,
    event.source_sequence,
    event.event_kind,
    JSON.stringify(event.payload || {}),
    event.occurred_at,
    nowIso(),
  );
  return db.prepare("SELECT * FROM domain_events WHERE id = ?").get(id);
}

function listDomainEvents() {
  return getDatabase().prepare("SELECT * FROM domain_events ORDER BY recorded_at, id").all();
}

// 订单时间线：编排全过程的可追溯记录
function addTimeline(orderId, eventType, detail = {}) {
  const db = getDatabase();
  const id = newId("tl");
  db.prepare(
    "INSERT INTO order_timeline(id, order_id, event_type, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, orderId, eventType, JSON.stringify(detail), nowIso());
  return id;
}

function listTimeline(orderId) {
  return getDatabase()
    .prepare("SELECT * FROM order_timeline WHERE order_id = ? ORDER BY created_at, id")
    .all(orderId)
    .map((row) => ({ ...row, detail: JSON.parse(row.detail_json) }));
}

// 向订单订阅方产生可追踪状态通知
function notify(orderId, kind, payload = {}) {
  const db = getDatabase();
  const id = newId("ntf");
  const productRef = payload.product_ref || "";
  const version = payload.version === undefined ? null : payload.version;
  db.prepare(
    `INSERT INTO notifications(id, order_id, product_ref, version, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, orderId, productRef, version, kind, JSON.stringify(payload), nowIso());
  return id;
}

function listNotifications(orderId) {
  return getDatabase()
    .prepare("SELECT * FROM notifications WHERE order_id = ? ORDER BY created_at, id")
    .all(orderId)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload), acked: Boolean(row.acked) }));
}

function acknowledgeNotification(notificationId) {
  const result = getDatabase().prepare("UPDATE notifications SET acked = 1 WHERE id = ?").run(notificationId);
  return result.changes > 0;
}

module.exports = {
  recordDomainEvent,
  listDomainEvents,
  addTimeline,
  listTimeline,
  notify,
  listNotifications,
  acknowledgeNotification,
};
