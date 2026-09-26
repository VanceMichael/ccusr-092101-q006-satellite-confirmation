
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, parseTime, normalizeBbox } = require("./util");
const spacecraft = require("./spacecraft");

// 登记一次成像机会（机会预报）
function registerOpportunity(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const sc = spacecraft.getSpacecraft(String(input.spacecraft_ref || ""));
  parseTime(input.window_start, "window_start");
  parseTime(input.window_end, "window_end");
  assert(Date.parse(input.window_start) < Date.parse(input.window_end), "window_start 必须早于 window_end");
  const box = normalizeBbox(input.bbox);
  const modes = Array.isArray(input.supported_modes) ? input.supported_modes.map(String) : [];
  const db = getDatabase();
  const id = newId("opp");
  db.prepare(
    `INSERT INTO imaging_opportunities
       (id, spacecraft_id, window_start, window_end, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat,
        supported_modes, energy_cost, storage_cost, receipt_due_after_minutes, revision, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'forecast', ?, ?)`,
  ).run(
    id, sc.id, input.window_start, input.window_end,
    box.minLon, box.minLat, box.maxLon, box.maxLat,
    JSON.stringify(modes),
    Number(input.energy_cost ?? 1),
    Number(input.storage_cost ?? 1),
    Number(input.receipt_due_after_minutes ?? 60),
    nowIso(), nowIso(),
  );
  return getOpportunity(id);
}

function getOpportunity(id) {
  const row = getDatabase().prepare("SELECT * FROM imaging_opportunities WHERE id = ?").get(id);
  if (!row) throw new NotFoundError(`成像机会不存在：${id}`);
  return hydrate(row);
}

function hydrate(row) {
  return {
    ...row,
    supported_modes: JSON.parse(row.supported_modes),
    bbox: [row.bbox_min_lon, row.bbox_min_lat, row.bbox_max_lon, row.bbox_max_lat],
  };
}

function listOpportunities(filter = {}) {
  const db = getDatabase();
  let sql = "SELECT * FROM imaging_opportunities";
  const where = [];
  const params = [];
  if (filter.status) { where.push("status = ?"); params.push(filter.status); }
  if (filter.spacecraft_ref) {
    const sc = spacecraft.getSpacecraft(filter.spacecraft_ref);
    where.push("spacecraft_id = ?");
    params.push(sc.id);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY window_start";
  return db.prepare(sql).all(...params).map(hydrate);
}

// 机会预报修订：旧机会标记 revised，新版本继承修订谱系；受影响订单由重排服务处理
function reviseOpportunity(opportunityId, changes) {
  const db = getDatabase();
  const old = getOpportunity(opportunityId);
  if (old.status === "revoked") throw new ConflictError("已撤销的机会不能修订");
  const scRef = db.prepare("SELECT ref FROM spacecraft WHERE id = ?").get(old.spacecraft_id).ref;
  const created = registerOpportunity({
    spacecraft_ref: scRef,
    window_start: changes.window_start || old.window_start,
    window_end: changes.window_end || old.window_end,
    bbox: changes.bbox || old.bbox,
    supported_modes: changes.supported_modes || old.supported_modes,
    energy_cost: changes.energy_cost ?? old.energy_cost,
    storage_cost: changes.storage_cost ?? old.storage_cost,
    receipt_due_after_minutes: changes.receipt_due_after_minutes ?? old.receipt_due_after_minutes,
  });
  const nextRevision = old.revision + 1;
  db.prepare("UPDATE imaging_opportunities SET revision = ?, supersedes_id = ?, updated_at = ? WHERE id = ?",
  ).run(nextRevision, old.id, nowIso(), created.id);
  db.prepare("UPDATE imaging_opportunities SET status = 'revised', updated_at = ? WHERE id = ?").run(nowIso(), old.id);
  return { old_opportunity: getOpportunity(old.id), new_opportunity: getOpportunity(created.id) };
}

// 撤销机会（预报取消）
function revokeOpportunity(opportunityId, reason = "") {
  const old = getOpportunity(opportunityId);
  getDatabase().prepare("UPDATE imaging_opportunities SET status = 'revoked', updated_at = ? WHERE id = ?").run(nowIso(), old.id);
  return { ...getOpportunity(opportunityId), revoke_reason: reason };
}

module.exports = {
  registerOpportunity,
  getOpportunity,
  listOpportunities,
  reviseOpportunity,
  revokeOpportunity,
  hydrateOpportunity: hydrate,
};
