
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, parseTime } = require("./util");

// 卫星按能力版本登记；机会匹配与候选评分均以版本能力为准
function registerSpacecraft(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const ref = String(input.ref || "");
  const name = String(input.name || "");
  const capabilityVersion = String(input.capability_version || "");
  assert(ref, "ref 必填");
  assert(name, "name 必填");
  assert(capabilityVersion, "capability_version 必填");
  const modes = Array.isArray(input.supported_modes) ? input.supported_modes.map(String) : [];
  const capabilities = {
    supported_modes: modes,
    onboard_intelligence: Boolean(input.onboard_intelligence), // 星上智能处理能力
    ...(typeof input.capabilities === "object" && input.capabilities !== null ? input.capabilities : {}),
  };
  const db = getDatabase();
  const existing = db.prepare("SELECT id FROM spacecraft WHERE ref = ?").get(ref);
  if (existing) throw new ConflictError(`卫星 ${ref} 已登记`);
  const id = newId("sc");
  db.prepare(
    `INSERT INTO spacecraft(id, ref, name, capability_version, status, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'available', ?, ?)`,
  ).run(id, ref, name, capabilityVersion, JSON.stringify(capabilities), nowIso());
  return getSpacecraft(id);
}

function getSpacecraft(idOrRef) {
  const row = getDatabase()
    .prepare("SELECT * FROM spacecraft WHERE id = ? OR ref = ?")
    .get(idOrRef, idOrRef);
  if (!row) throw new NotFoundError(`卫星不存在：${idOrRef}`);
  return hydrate(row);
}

function listSpacecraft() {
  return getDatabase().prepare("SELECT * FROM spacecraft ORDER BY ref").all().map(hydrate);
}

function hydrate(row) {
  return { ...row, metadata: JSON.parse(row.metadata_json), available: row.status === "available" };
}

// 卫星不可用（后续只影响依赖该卫星未完成分配的订单）
function markSpacecraftUnavailable(ref, reason = "") {
  const db = getDatabase();
  const sc = getSpacecraft(ref);
  db.prepare("UPDATE spacecraft SET status = ? WHERE id = ?").run("unavailable", sc.id);
  return { ...getSpacecraft(sc.id), unavailable_reason: reason };
}

function markSpacecraftAvailable(ref) {
  const sc = getSpacecraft(ref);
  getDatabase().prepare("UPDATE spacecraft SET status = ? WHERE id = ?").run("available", sc.id);
  return getSpacecraft(sc.id);
}

module.exports = {
  registerSpacecraft,
  getSpacecraft,
  listSpacecraft,
  markSpacecraftUnavailable,
  markSpacecraftAvailable,
};
