
const { getDatabase } = require("./db");
const { newId, nowIso, assert, ConflictError, NotFoundError, normalizeBbox, bboxIntersects } = require("./util");

// ---- 授权范围（数据使用边界）----

function registerScope(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const code = String(input.code || "");
  const ownerDept = String(input.owner_dept || "");
  assert(code, "scope.code 必填");
  assert(ownerDept, "scope.owner_dept 必填");
  const db = getDatabase();
  if (db.prepare("SELECT id FROM authorization_scopes WHERE code = ?").get(code)) {
    throw new ConflictError(`授权范围 ${code} 已存在`);
  }
  const id = newId("scope");
  db.prepare(
    "INSERT INTO authorization_scopes(id, code, owner_dept, description, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, code, ownerDept, String(input.description || ""), nowIso());
  return getScope(code);
}

function getScope(code) {
  const row = getDatabase().prepare("SELECT * FROM authorization_scopes WHERE code = ?").get(code);
  if (!row) throw new NotFoundError(`授权范围不存在：${code}`);
  return row;
}

function listScopes() {
  return getDatabase().prepare("SELECT * FROM authorization_scopes ORDER BY code").all();
}

// ---- 目标与别名 ----

function registerTarget(input) {
  assert(input && typeof input === "object", "请求体必须是对象");
  const ref = String(input.ref || "");
  const name = String(input.name || "");
  assert(ref, "target.ref 必填");
  assert(name, "target.name 必填");
  const box = normalizeBbox(input.bbox);
  const aliases = Array.isArray(input.aliases) ? input.aliases.map((a) => String(a).trim()).filter(Boolean) : [];
  const scopeCodes = Array.isArray(input.scope_codes) ? input.scope_codes.map(String) : [];

  const db = getDatabase();
  if (db.prepare("SELECT id FROM targets WHERE ref = ?").get(ref)) {
    throw new ConflictError(`目标 ${ref} 已登记`);
  }
  for (const code of scopeCodes) getScope(code); // 范围必须先存在

  // 同一名称或别名被不同目标登记过：视为同一目标的疑似重复下单线索
  const allNames = [name, ...aliases];
  const collisions = findNameCollisions(db, allNames);

  const id = newId("tgt");
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO targets(id, ref, name, bbox, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ref, name, JSON.stringify([box.minLon, box.minLat, box.maxLon, box.maxLat]),
      box.minLon, box.minLat, box.maxLon, box.maxLat, nowIso());
    for (const alias of aliases) {
      db.prepare("INSERT INTO target_aliases(id, target_id, alias) VALUES (?, ?, ?)").run(newId("als"), id, alias);
    }
    for (const code of scopeCodes) {
      db.prepare("INSERT OR IGNORE INTO target_scopes(target_id, scope_code) VALUES (?, ?)").run(id, code);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { ...getTarget(id), name_collisions: collisions };
}

function findNameCollisions(db, names) {
  const found = [];
  for (const n of names) {
    const byName = db.prepare("SELECT id, ref, name FROM targets WHERE name = ?").all(n);
    const byAlias = db.prepare(
      `SELECT t.id, t.ref, t.name FROM target_aliases a JOIN targets t ON t.id = a.target_id WHERE a.alias = ?`,
    ).all(n);
    for (const row of [...byName, ...byAlias]) {
      if (!found.some((f) => f.target_id === row.id)) found.push({ target_id: row.id, ref: row.ref, name: row.name, matched_on: n });
    }
  }
  return found;
}

function getTarget(idOrRef) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM targets WHERE id = ? OR ref = ?").get(idOrRef, idOrRef);
  if (!row) throw new NotFoundError(`目标不存在：${idOrRef}`);
  return hydrateTarget(db, row);
}

function hydrateTarget(db, row) {
  const aliases = db.prepare("SELECT alias FROM target_aliases WHERE target_id = ?").all(row.id).map((r) => r.alias);
  const scopes = db.prepare("SELECT scope_code FROM target_scopes WHERE target_id = ?").all(row.id).map((r) => r.scope_code);
  return {
    id: row.id,
    ref: row.ref,
    name: row.name,
    bbox: JSON.parse(row.bbox),
    aliases,
    scope_codes: scopes,
    created_at: row.created_at,
  };
}

function listTargets() {
  const db = getDatabase();
  return db.prepare("SELECT * FROM targets ORDER BY ref").all().map((row) => hydrateTarget(db, row));
}

// 按名称或别名解析目标
function resolveTargetByName(name) {
  const db = getDatabase();
  let row = db.prepare("SELECT * FROM targets WHERE name = ?").get(name);
  if (!row) {
    row = db.prepare(
      `SELECT t.* FROM target_aliases a JOIN targets t ON t.id = a.target_id WHERE a.alias = ?`,
    ).get(name);
  }
  return row ? hydrateTarget(db, row) : null;
}

// 几何 + 名称双重叠检测，返回重叠的现存订单（调用方据此决定是否提示合并）
// 不同授权范围只提示几何重叠，绝不能据此共享数据。
function findOverlappingOrders(target, options = {}) {
  const excludeOrderId = options.excludeOrderId || null;
  const scopeCode = options.scopeCode || null;
  const db = getDatabase();
  const box = {
    minLon: target.bbox[0], minLat: target.bbox[1],
    maxLon: target.bbox[2], maxLat: target.bbox[3],
  };
  const result = [];
  for (const order of db.prepare("SELECT o.*, t.bbox_min_lon, t.bbox_min_lat, t.bbox_max_lon, t.bbox_max_lat FROM orders o JOIN targets t ON t.id = o.target_id").all()) {
    if (excludeOrderId && order.id === excludeOrderId) continue;
    if (order.status === "cancelled" || order.status === "closed") continue;
    const otherBox = {
      minLon: order.bbox_min_lon, minLat: order.bbox_min_lat,
      maxLon: order.bbox_max_lon, maxLat: order.bbox_max_lat,
    };
    const sameTarget = order.target_id === target.id || order.target_name_live === target.name;
    if (!sameTarget && !bboxIntersects(box, otherBox)) continue;
    result.push({
      order_ref: order.ref,
      department: order.department,
      target_name: order.target_name_live,
      scope_code: order.scope_code,
      timeliness: order.timeliness,
      overlap_kind: sameTarget ? "same_target" : "geometry",
      same_authorization_scope: scopeCode ? order.scope_code === scopeCode : null,
      sharing_allowed: scopeCode ? order.scope_code === scopeCode : null,
    });
  }
  return result;
}

// 授权边界判定：不同授权范围之间不得擅自共享数据/目标
function scopeAllowsSharing(scopeCodeA, scopeCodeB) {
  return scopeCodeA === scopeCodeB;
}

module.exports = {
  registerScope,
  getScope,
  listScopes,
  registerTarget,
  getTarget,
  listTargets,
  resolveTargetByName,
  findOverlappingOrders,
  scopeAllowsSharing,
};
