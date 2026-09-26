
const { inTransaction } = require("./db");
const { recordOrderEvent } = require("./events");
const { nowIso, newId, parseIso, httpError, bboxOf, bboxIntersection, bboxArea, coverageRatio, requireFields, asStringArray } = require("./util");

const TIMELINESS_LEVELS = new Set(["emergency", "routine", "refresh"]);
const OVERLAP_HINT = 0.20;   // 目标面积覆盖率达到该值即提示
const SAME_TARGET_HINT = 0.80;

// ---- 订阅方授权登记 ----

function registerSubscriber(db, input) {
  requireFields(input, ["subscriber_ref", "granted_scopes"]);
  const scopes = asStringArray(input.granted_scopes, "granted_scopes");
  const existing = db.prepare("SELECT subscriber_ref FROM data_subscriber WHERE subscriber_ref = ?").get(input.subscriber_ref);
  if (existing) {
    db.prepare("UPDATE data_subscriber SET granted_scopes = ? WHERE subscriber_ref = ?").run(JSON.stringify(scopes), input.subscriber_ref);
  } else {
    db.prepare("INSERT INTO data_subscriber(subscriber_ref, granted_scopes, created_at) VALUES (?, ?, ?)")
      .run(input.subscriber_ref, JSON.stringify(scopes), nowIso());
  }
  return getSubscriber(db, input.subscriber_ref);
}

function getSubscriber(db, ref) {
  const row = db.prepare("SELECT * FROM data_subscriber WHERE subscriber_ref = ?").get(ref);
  if (!row) throw httpError(404, "subscriber_not_found", `订阅方 ${ref} 未登记`);
  return { ...row, granted_scopes: JSON.parse(row.granted_scopes) };
}

function assertScopeGranted(db, subscriberRef, scope) {
  const subscriber = getSubscriber(db, subscriberRef);
  if (!subscriber.granted_scopes.includes(scope)) {
    throw httpError(403, "scope_not_granted",
      `订阅方 ${subscriberRef} 不在授权范围 ${scope} 内，不得共享数据`,
      { subscriber_ref: subscriberRef, required_scope: scope });
  }
  return subscriber;
}

// ---- 订单统一登记 ----

function registerOrder(db, input) {
  requireFields(input, [
    "department", "target_name", "footprint", "allowed_start", "allowed_end",
    "imaging_modes", "timeliness", "delivery_recipients", "data_scope", "storage_mb", "deadline",
  ]);
  if (!TIMELINESS_LEVELS.has(input.timeliness)) {
    throw httpError(400, "invalid_timeliness", `timeliness 必须是 ${[...TIMELINESS_LEVELS].join(" | ")}`);
  }
  const imagingModes = asStringArray(input.imaging_modes, "imaging_modes");
  const recipients = asStringArray(input.delivery_recipients, "delivery_recipients");
  const aliases = input.target_aliases ? asStringArray(input.target_aliases, "target_aliases") : [];
  const allowedStart = parseIso(input.allowed_start, "allowed_start");
  const allowedEnd = parseIso(input.allowed_end, "allowed_end");
  const deadline = parseIso(input.deadline, "deadline");
  if (allowedEnd <= allowedStart) throw httpError(400, "invalid_window", "allowed_end 必须晚于 allowed_start");
  const geometry = input.footprint.length === 4 && input.footprint.every((n) => typeof n === "number")
    ? bboxToPolygon(input.footprint)
    : input.footprint;
  const bbox = bboxOf(input.footprint);
  if (!Number.isFinite(input.storage_mb) || input.storage_mb <= 0) {
    throw httpError(400, "invalid_field", "storage_mb 必须为正数");
  }

  const orderId = input.order_id || newId("ord");

  return inTransaction(db, () => {
    // 交付对象必须在订单的数据授权范围内，防止跨范围共享
    for (const recipient of recipients) assertScopeGranted(db, recipient, input.data_scope);

    db.prepare(
      `INSERT INTO observation_order(order_id, department, target_name, target_aliases, geometry, bbox,
          allowed_start, allowed_end, imaging_modes, timeliness, delivery_recipients, data_scope,
          data_usage_terms, storage_mb, expected_shards, deadline, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)`
    ).run(
      orderId, input.department, input.target_name, JSON.stringify([...new Set([input.target_name, ...aliases])]),
      JSON.stringify(geometry), JSON.stringify(bbox),
      allowedStart.toISOString(), allowedEnd.toISOString(), JSON.stringify(imagingModes),
      input.timeliness, JSON.stringify(recipients), input.data_scope,
      input.data_usage_terms ?? null, input.storage_mb,
      Number.isInteger(input.expected_shards) ? input.expected_shards : null,
      deadline.toISOString(), nowIso()
    );

    for (const alias of new Set([input.target_name, ...aliases])) {
      db.prepare("INSERT OR IGNORE INTO target_alias(alias_key, order_id, target_name, data_scope) VALUES (?, ?, ?, ?)")
        .run(normalizeAlias(alias), orderId, input.target_name, input.data_scope);
    }

    // 自动登记交付订阅
    for (const recipient of recipients) {
      db.prepare(
        `INSERT OR IGNORE INTO product_subscription(subscriber_ref, product_id, order_id, data_scope, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(recipient, orderId, orderId, input.data_scope, nowIso());
    }

    recordOrderEvent(db, orderId, "order_registered", {
      department: input.department,
      target_name: input.target_name,
      timeliness: input.timeliness,
      data_scope: input.data_scope,
      recipients,
    });

    const suggestions = detectDuplicates(db, orderId);
    return { order: getOrder(db, orderId), duplicate_suggestions: suggestions };
  });
}

function normalizeAlias(name) {
  return String(name).trim().toLowerCase().replace(/[\s\-_·]+/g, "");
}

// 防止同一目标被不同部门以不同名称重复下单：只提示合并，绝不自动合并；
// 授权范围不同的，提示中标注 scope_compatible=false，禁止共享数据。
function detectDuplicates(db, orderId) {
  const order = getOrder(db, orderId);
  const aliasKeys = db.prepare("SELECT alias_key FROM target_alias WHERE order_id = ?").all(orderId).map((r) => r.alias_key);

  const aliasHits = aliasKeys.length
    ? db.prepare(
        `SELECT DISTINCT o.order_id, o.target_name, o.department, o.data_scope, o.bbox
         FROM target_alias t
         JOIN observation_order o ON o.order_id = t.order_id
         WHERE t.alias_key IN (${aliasKeys.map(() => "?").join(",")})
           AND t.order_id != ? AND o.merged_into IS NULL AND o.status NOT IN ('delivered', 'merged')`
      ).all(...aliasKeys, orderId)
    : [];

  const geomHits = db
    .prepare(
      `SELECT order_id, target_name, department, data_scope, bbox FROM observation_order
       WHERE order_id != ? AND merged_into IS NULL AND status NOT IN ('delivered', 'merged')`
    )
    .all(orderId)
    .map((row) => {
      const overlap = coverageRatio(order.bbox, JSON.parse(row.bbox));
      const reverse = coverageRatio(JSON.parse(row.bbox), order.bbox);
      return { row, ratio: Math.max(overlap, reverse) };
    })
    .filter((item) => item.ratio >= OVERLAP_HINT);

  const suggestions = [];
  const seen = new Set();

  for (const hit of aliasHits) {
    const key = `${hit.order_id}:alias_match`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ratio = Number(coverageRatio(order.bbox, JSON.parse(hit.bbox)).toFixed(4));
    suggestions.push(persistSuggestion(db, order, hit, "alias_match", ratio >= OVERLAP_HINT ? ratio : null));
  }
  for (const { row, ratio } of geomHits) {
    const key = `${row.order_id}:geometry_overlap`;
    if (seen.has(`${row.order_id}:alias_match`)) continue; // 别名命中已提示
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(persistSuggestion(db, order, row, "geometry_overlap", Number(ratio.toFixed(4))));
  }
  return suggestions;
}

function persistSuggestion(db, order, other, matchKind, overlapRatio) {
  const scopeCompatible = order.data_scope === other.data_scope;
  const suggestionId = newId("mrg");
  db.prepare(
    `INSERT INTO merge_suggestion(suggestion_id, order_id, other_order_id, match_kind, overlap_ratio,
        scope_compatible, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
     ON CONFLICT(order_id, other_order_id, match_kind) DO NOTHING`
  ).run(suggestionId, order.order_id, other.order_id, matchKind, overlapRatio, scopeCompatible ? 1 : 0, nowIso());
  const row = db.prepare("SELECT * FROM merge_suggestion WHERE order_id = ? AND other_order_id = ? AND match_kind = ?")
    .get(order.order_id, other.order_id, matchKind);
  return hydrateSuggestion(row, other, scopeCompatible);
}

function hydrateSuggestion(row, other, scopeCompatible) {
  const otherName = other?.target_name ?? other?.other_target_name ?? null;
  const otherDepartment = other?.department ?? other?.other_department ?? null;
  return {
    suggestion_id: row.suggestion_id,
    order_id: row.order_id,
    other_order_id: row.other_order_id,
    other_target_name: otherName,
    other_department: otherDepartment,
    match_kind: row.match_kind,
    overlap_ratio: row.overlap_ratio,
    scope_compatible: Boolean(row.scope_compatible),
    sharing_allowed: Boolean(row.scope_compatible),
    recommendation: scopeCompatible
      ? (row.overlap_ratio >= SAME_TARGET_HINT ? "建议合并下单以节省成像机会" : "目标部分重叠，建议协调边界")
      : "授权范围不同：仅可协调排期，不得共享或合并数据",
    status: row.status,
  };
}

// 任务经理决定接受合并：把订单标记 merged；仍要求两单授权范围一致
function acceptMerge(db, input) {
  requireFields(input, ["suggestion_id"]);
  const suggestion = db.prepare("SELECT * FROM merge_suggestion WHERE suggestion_id = ?").get(input.suggestion_id);
  if (!suggestion) throw httpError(404, "suggestion_not_found", "合并提示不存在");
  if (suggestion.status !== "open") throw httpError(409, "suggestion_closed", `合并提示已 ${suggestion.status}`);
  if (!suggestion.scope_compatible) {
    db.prepare("UPDATE merge_suggestion SET status = 'blocked_scope' WHERE suggestion_id = ?").run(input.suggestion_id);
    throw httpError(403, "scope_crosses_boundary",
      "两份订单属于不同授权范围，不得合并或共享数据",
      { order_id: suggestion.order_id, other_order_id: suggestion.other_order_id });
  }
  return inTransaction(db, () => {
    db.prepare("UPDATE merge_suggestion SET status = 'accepted' WHERE suggestion_id = ?").run(input.suggestion_id);
    db.prepare("UPDATE observation_order SET status = 'merged', merged_into = ? WHERE order_id = ?")
      .run(suggestion.other_order_id, suggestion.order_id);
    recordOrderEvent(db, suggestion.order_id, "order_merged", { merged_into: suggestion.other_order_id });
    recordOrderEvent(db, suggestion.other_order_id, "order_absorbed", { absorbed_order: suggestion.order_id });
    return { merged_order: suggestion.order_id, into: suggestion.other_order_id };
  });
}

function dismissMerge(db, input) {
  requireFields(input, ["suggestion_id"]);
  db.prepare("UPDATE merge_suggestion SET status = 'dismissed' WHERE suggestion_id = ?").run(input.suggestion_id);
  return { suggestion_id: input.suggestion_id, status: "dismissed" };
}

function getOrder(db, orderId) {
  const row = db.prepare("SELECT * FROM observation_order WHERE order_id = ?").get(orderId);
  if (!row) throw httpError(404, "order_not_found", `订单 ${orderId} 不存在`);
  return hydrateOrder(row);
}

function listOrders(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.department) {
    clauses.push("department = ?");
    params.push(filter.department);
  }
  if (filter.timeliness) {
    clauses.push("timeliness = ?");
    params.push(filter.timeliness);
  }
  const sql = `SELECT * FROM observation_order ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at`;
  return db.prepare(sql).all(...params).map(hydrateOrder);
}

function hydrateOrder(row) {
  return {
    ...row,
    target_aliases: JSON.parse(row.target_aliases),
    geometry: JSON.parse(row.geometry),
    bbox: JSON.parse(row.bbox),
    imaging_modes: JSON.parse(row.imaging_modes),
    delivery_recipients: JSON.parse(row.delivery_recipients),
  };
}

function listMergeSuggestions(db, filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.order_id) {
    clauses.push("s.order_id = ? OR s.other_order_id = ?");
    params.push(filter.order_id, filter.order_id);
  }
  if (filter.status) {
    clauses.push("s.status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT s.*, o.target_name AS other_target_name, o.department AS other_department
               FROM merge_suggestion s
               JOIN observation_order o ON o.order_id = s.other_order_id
               ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
               ORDER BY s.created_at`;
  return db.prepare(sql).all(...params).map((row) => hydrateSuggestion(row, row, Boolean(row.scope_compatible)));
}

function bboxToPolygon(bbox) {
  const [w, s, e, n] = bbox;
  return {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

module.exports = {
  registerSubscriber,
  getSubscriber,
  assertScopeGranted,
  registerOrder,
  acceptMerge,
  dismissMerge,
  getOrder,
  listOrders,
  listMergeSuggestions,
  detectDuplicates,
  normalizeAlias,
  TIMELINESS_LEVELS,
};
