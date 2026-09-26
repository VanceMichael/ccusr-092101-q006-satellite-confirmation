
const {
  registerSpacecraft,
  updateCapability,
  markSpacecraftUnavailable,
  markSpacecraftAvailable,
  listSpacecraft,
  getSpacecraft,
  publishOpportunity,
  reviseOpportunity,
  listOpportunities,
  getOpportunity,
} = require("./catalog");
const {
  registerSubscriber,
  registerOrder,
  acceptMerge,
  dismissMerge,
  getOrder,
  listOrders,
  listMergeSuggestions,
} = require("./orders");
const {
  generateCandidates,
  listCandidates,
  buildDraftPlan,
  freezePlan,
  getPlan,
  prepareEmergencyInsertion,
  decideEmergencyInsertion,
  getApproval,
  listApprovals,
} = require("./planning");
const {
  listReplanning,
  reportExecution,
  markReceiptLate,
  replan,
} = require("./replanning");
const {
  subscribe,
  receiveShard,
  detectMissingShards,
  reprocess,
  withdraw,
  getProduct,
  listNotifications,
  acknowledgeNotification,
} = require("./products");
const { explainOrder } = require("./traceability");
const { httpError } = require("./util");

// 路由声明：[method, pattern, handler]，pattern 中的 :name 提取路径参数
const routes = [];
function route(method, pattern, handler) {
  const segments = pattern.split("/").filter(Boolean).map((segment) =>
    segment.startsWith(":") ? { param: segment.slice(1) } : { literal: segment }
  );
  routes.push({ method, segments, handler });
}

function sourceFrom(query) {
  if (!query.source_ref) return {};
  return { source_ref: query.source_ref, source_sequence: Number(query.source_sequence) };
}

function registerRoutes() {
  // ---- 健康 ----
  route("GET", "/health", () => ({ status: "ok" }));

  // ---- 卫星目录 ----
  route("POST", "/spacecraft", (db, body, query) => registerSpacecraft(db, body, sourceFrom(query)));
  route("GET", "/spacecraft", (db) => listSpacecraft(db));
  route("GET", "/spacecraft/:ref", (db, body, query, params) => getSpacecraft(db, params.ref));
  route("PUT", "/spacecraft/:ref/capability", (db, body, query, params) =>
    updateCapability(db, { ...body, spacecraft_ref: params.ref }, sourceFrom(query)));
  route("POST", "/spacecraft/:ref/unavailable", (db, body, query, params) =>
    markSpacecraftUnavailable(db, { ...body, spacecraft_ref: params.ref }, sourceFrom(query)));
  route("POST", "/spacecraft/:ref/available", (db, body, query, params) =>
    markSpacecraftAvailable(db, { ...body, spacecraft_ref: params.ref }, sourceFrom(query)));

  // ---- 成像机会 ----
  route("POST", "/opportunities", (db, body, query) => publishOpportunity(db, body, sourceFrom(query)));
  route("GET", "/opportunities", (db, body, query) =>
    listOpportunities(db, { spacecraft_ref: query.spacecraft_ref, status: query.status }));
  route("GET", "/opportunities/:id", (db, body, query, params) => getOpportunity(db, params.id));
  route("POST", "/opportunities/:id/revise", (db, body, query, params) =>
    reviseOpportunity(db, { ...body, opportunity_id: params.id }, sourceFrom(query)));

  // ---- 订阅方授权 ----
  route("POST", "/subscribers", (db, body) => registerSubscriber(db, body));

  // ---- 订单登记 ----
  route("POST", "/orders", (db, body) => registerOrder(db, body));
  route("GET", "/orders", (db, body, query) =>
    listOrders(db, { status: query.status, department: query.department, timeliness: query.timeliness }));
  route("GET", "/orders/:id", (db, body, query, params) => getOrder(db, params.id));
  route("GET", "/orders/:id/explain", (db, body, query, params) => explainOrder(db, params.id));
  route("GET", "/orders/:id/candidates", (db, body, query, params) =>
    ({ order_id: params.id, candidates: listCandidates(db, params.id) }));
  route("POST", "/orders/:id/candidates", (db, body, query, params) => generateCandidates(db, params.id));
  route("GET", "/orders/:id/replanning", (db, body, query, params) =>
    ({ order_id: params.id, replanning: listReplanning(db).filter((r) => r.order_id === params.id) }));

  // ---- 合并提示 ----
  route("GET", "/merge-suggestions", (db, body, query) =>
    listMergeSuggestions(db, { order_id: query.order_id, status: query.status }));
  route("POST", "/merge-suggestions/:id/accept", (db, body, query, params) => acceptMerge(db, { ...body, suggestion_id: params.id }));
  route("POST", "/merge-suggestions/:id/dismiss", (db, body, query, params) => dismissMerge(db, { ...body, suggestion_id: params.id }));

  // ---- 计划 ----
  route("POST", "/plans/draft", (db, body) => buildDraftPlan(db, body || {}));
  route("GET", "/plans/:id", (db, body, query, params) => getPlan(db, params.id));
  route("POST", "/plans/:id/freeze", (db, body, query, params) => freezePlan(db, params.id, query.actor_ref));
  route("GET", "/approvals", (db, body, query) => listApprovals(db, { status: query.status }));
  route("GET", "/approvals/:id", (db, body, query, params) => getApproval(db, params.id));

  // ---- 应急插单 ----
  route("POST", "/orders/:id/emergency-insertion", (db, body, query, params) =>
    prepareEmergencyInsertion(db, { ...(body || {}), order_id: params.id }));
  route("POST", "/approvals/:id/approve", (db, body, query, params) =>
    decideEmergencyInsertion(db, params.id, "approved", { ...(body || {}), approver_ref: body?.approver_ref || query.actor_ref }));
  route("POST", "/approvals/:id/reject", (db, body, query, params) =>
    decideEmergencyInsertion(db, params.id, "rejected", { ...(body || {}), approver_ref: body?.approver_ref || query.actor_ref }));

  // ---- 重排与执行 ----
  route("GET", "/replanning", (db) => ({ pending: listReplanning(db) }));
  route("POST", "/replanning/run", (db, body, query) => replan(db, body || {}, query.actor_ref));
  route("POST", "/allocations/:id/receipt", (db, body, query, params) =>
    reportExecution(db, { ...(body || {}), allocation_id: params.id }, sourceFrom(query)));
  route("POST", "/allocations/:id/late", (db, body, query, params) =>
    markReceiptLate(db, { ...(body || {}), allocation_id: params.id }, sourceFrom(query)));

  // ---- 数据产品 ----
  route("POST", "/products/subscribe", (db, body) => subscribe(db, body));
  route("POST", "/products/shards", (db, body, query) => receiveShard(db, body, sourceFrom(query)));
  route("POST", "/products/missing-check", (db, body) => detectMissingShards(db, body));
  route("POST", "/products/reprocess", (db, body, query) => reprocess(db, body, query.actor_ref));
  route("POST", "/products/withdraw", (db, body, query) => withdraw(db, body, query.actor_ref));
  route("GET", "/products/:id", (db, body, query, params) => getProduct(db, params.id));
  route("GET", "/notifications", (db, body, query) =>
    listNotifications(db, { subscriber_ref: query.subscriber_ref, product_id: query.product_id, status: query.status }));
  route("POST", "/notifications/:id/ack", (db, body, query, params) =>
    acknowledgeNotification(db, { ...(body || {}), notification_id: params.id }));
}

function dispatch(db, method, pathname, body, query) {
  const urlSegments = pathname.split("/").filter(Boolean);
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== urlSegments.length) continue;
    const params = {};
    const matched = candidate.segments.every((segment, index) => {
      if (segment.literal !== undefined) return segment.literal === urlSegments[index];
      params[segment.param] = decodeURIComponent(urlSegments[index]);
      return true;
    });
    if (matched) return candidate.handler(db, body, query, params);
  }
  throw httpError(404, "not_found", `没有匹配的接口：${method} ${pathname}`);
}

module.exports = { registerRoutes, dispatch };
