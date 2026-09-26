
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, parseTime } = require("./util");
const planning = require("./planning");
const { recordDomainEvent, addTimeline } = require("./events");

// 登记卫星执行回执（携带来源与序列号，幂等）。晚到、成功、失败均如实记录。
function recordReceipt(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const assignment = planning.getAssignment(String(input.assignment_ref || input.assignment_id || ""));
  const sourceRef = String(input.source_ref || "");
  const sourceSequence = Number(input.source_sequence);
  assert(sourceRef, "source_ref 必填");
  assert(Number.isInteger(sourceSequence), "source_sequence 必须是整数");
  const result = String(input.result || "");
  if (!["imaged", "failed"].includes(result)) {
    throw new (require("./util").ValidationError)("result 必须为 imaged 或 failed");
  }
  const occurredAt = parseTime(input.occurred_at, "occurred_at");
  const receivedAt = input.received_at ? parseTime(input.received_at, "received_at") : nowIso();
  const expectedShards = Number(input.expected_shards ?? 0);

  const db = getDatabase();
  if (db.prepare("SELECT id FROM execution_receipts WHERE source_ref = ? AND source_sequence = ?")
    .get(sourceRef, sourceSequence)) {
    throw new ConflictError("相同来源与序列号的回执已登记（幂等冲突）");
  }

  const id = newId("rcp");
  db.prepare(
    `INSERT INTO execution_receipts
       (id, assignment_id, source_ref, source_sequence, result, expected_shards, occurred_at, received_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, assignment.id, sourceRef, sourceSequence, result, expectedShards, occurredAt, receivedAt,
    String(input.detail || ""));
  recordDomainEvent({
    source_ref: sourceRef,
    source_sequence: sourceSequence,
    event_kind: `execution_${result}`,
    payload: { assignment_ref: assignment.id, occurred_at: occurredAt, expected_shards: expectedShards },
    occurred_at: occurredAt,
  });

  const late = assignment.receipt_due_at ? Date.parse(receivedAt) > Date.parse(assignment.receipt_due_at) : false;
  let effect = "recorded";
  let replan = null;

  if (["scheduled", "executing"].includes(assignment.state)) {
    if (result === "imaged") {
      db.prepare("UPDATE plan_assignments SET state = 'imaged' WHERE id = ?").run(assignment.id);
      db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(nowIso(), assignment.order_id);
      addTimeline(assignment.order_id, "receipt_imaged", {
        assignment_ref: assignment.id, source_ref: sourceRef, expected_shards: expectedShards, late,
      });
      effect = late ? "imaged_late" : "imaged";
    } else {
      db.prepare("UPDATE plan_assignments SET state = 'failed', displaced_reason = 'execution_failed' WHERE id = ?")
        .run(assignment.id);
      addTimeline(assignment.order_id, "receipt_failed", { assignment_ref: assignment.id, source_ref: sourceRef });
      effect = "failed";
      const replanning = require("./replanning");
      replan = replanning.replanOrders({
        trigger_kind: "execution_failed",
        trigger_ref: sourceRef,
        detail: `执行回执报告成像失败（${sourceRef}#${sourceSequence}）`,
        orderIds: [assignment.order_id],
        oldAssignments: [replanning.snapshotAssignment(
          db.prepare("SELECT * FROM plan_assignments WHERE id = ?").get(assignment.id))],
      });
    }
  } else if (assignment.state === "failed" && assignment.displaced_reason === "receipt_late") {
    // 回执晚到：重排已执行，迟到事实仅登记，不改变既成计划；其数据若下传仍按原计划汇聚
    addTimeline(assignment.order_id, "late_receipt_after_replan", {
      assignment_ref: assignment.id, result, source_ref: sourceRef,
      note: "回执晚到：重排已执行，迟到事实仅登记；其数据若下传仍按原计划汇聚",
    });
    effect = "late_after_replan";
  }

  return { ...getReceipt(id), late, effect, replan };
}

function getReceipt(id) {
  const row = getDatabase().prepare("SELECT * FROM execution_receipts WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`回执不存在：${id}`);
  return row;
}

function listReceipts(filter = {}) {
  const db = getDatabase();
  if (filter.order_ref) {
    const order = require("./orders").getOrder(filter.order_ref);
    return db.prepare(
      `SELECT r.* FROM execution_receipts r
         JOIN plan_assignments a ON a.id = r.assignment_id
        WHERE a.order_id = ? ORDER BY r.received_at`,
    ).all(order.id);
  }
  if (filter.assignment_ref) {
    return db.prepare("SELECT * FROM execution_receipts WHERE assignment_id = ? ORDER BY received_at")
      .all(filter.assignment_ref);
  }
  return db.prepare("SELECT * FROM execution_receipts ORDER BY received_at").all();
}

module.exports = { recordReceipt, getReceipt, listReceipts };
