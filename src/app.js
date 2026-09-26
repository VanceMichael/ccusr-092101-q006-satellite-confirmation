
const http = require("node:http");
const { getDatabase } = require("./db");
const spacecraftService = require("./spacecraft");
const targetsService = require("./targets");
const ordersService = require("./orders");
const opportunitiesService = require("./opportunities");
const planning = require("./planning");
const emergency = require("./emergency");
const replanning = require("./replanning");
const receiptsService = require("./receipts");
const productsService = require("./products");
const explainService = require("./explain");
const eventsService = require("./events");
const { ValidationError, NotFoundError, ConflictError } = require("./util");

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ValidationError("请求体必须是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

// 路由表：[method, pattern(分段，:name 为参数), handler]
const routes = [
  ["GET", "/health", async () => ({ status: "ok" })],

  // 主数据
  ["POST", "/spacecraft", async (body) => spacecraftService.registerSpacecraft(body)],
  ["GET", "/spacecraft", async () => spacecraftService.listSpacecraft()],
  ["POST", "/spacecraft/:ref/unavailable", async (body, params) =>
    replanning.handleSpacecraftUnavailable(params.ref, body.reason || "")],
  ["POST", "/spacecraft/:ref/available", async (body, params) =>
    spacecraftService.markSpacecraftAvailable(params.ref)],
  ["POST", "/scopes", async (body) => targetsService.registerScope(body)],
  ["GET", "/scopes", async () => targetsService.listScopes()],
  ["POST", "/targets", async (body) => targetsService.registerTarget(body)],
  ["GET", "/targets", async () => targetsService.listTargets()],
  ["GET", "/targets/:ref", async (body, params) => targetsService.getTarget(params.ref)],

  // 订单
  ["POST", "/orders", async (body) => ordersService.submitOrder(body)],
  ["GET", "/orders", async (body, params, query) =>
    ordersService.listOrders({ status: query.get("status") || undefined, department: query.get("department") || undefined })],
  ["GET", "/orders/:ref", async (body, params) => ordersService.getOrder(params.ref)],
  ["POST", "/orders/:ref/merge", async (body, params) =>
    ordersService.acceptMerge(params.ref, String(body.other_ref || ""))],
  ["POST", "/orders/:ref/cancel", async (body, params) =>
    ordersService.cancelOrder(params.ref, body.reason || "")],
  ["GET", "/orders/:ref/explanation", async (body, params) => explainService.explainOrder(params.ref)],
  ["GET", "/orders/:ref/timeline", async (body, params) => {
    const order = ordersService.getOrder(params.ref);
    return eventsService.listTimeline(order.id);
  }],
  ["GET", "/orders/:ref/notifications", async (body, params) => {
    const order = ordersService.getOrder(params.ref);
    return eventsService.listNotifications(order.id);
  }],
  ["POST", "/orders/:ref/subscriptions", async (body, params) =>
    productsService.subscribe(params.ref, body.subscriber)],
  ["GET", "/orders/:ref/deliveries", async (body, params) => productsService.listDeliveries(params.ref)],

  // 成像机会
  ["POST", "/opportunities", async (body) => opportunitiesService.registerOpportunity(body)],
  ["GET", "/opportunities", async (body, params, query) =>
    opportunitiesService.listOpportunities({
      status: query.get("status") || undefined,
      spacecraft_ref: query.get("spacecraft_ref") || undefined,
    })],
  ["POST", "/opportunities/:id/revise", async (body, params) =>
    replanning.handleOpportunityRevised(params.id, body)],
  ["POST", "/opportunities/:id/revoke", async (body, params) =>
    replanning.handleOpportunityRevoked(params.id, body.reason || "")],

  // 计划
  ["POST", "/plan-runs", async (body) => planning.createPlanRun(body)],
  ["GET", "/plan-runs", async () => planning.listPlanRuns()],
  ["GET", "/plan-runs/:id", async (body, params) => planning.getPlanRun(params.id)],
  ["POST", "/plan-runs/:id/freeze", async (body, params) => planning.freezePlanRun(params.id)],
  ["GET", "/assignments", async (body, params, query) =>
    planning.listAssignments({ state: query.get("state") || undefined, orderRef: query.get("order_ref") || undefined })],
  ["GET", "/assignments/:id", async (body, params) => planning.getAssignment(params.id)],

  // 应急插单
  ["POST", "/emergency/insertions", async (body) => emergency.proposeEmergencyInsertion(body)],
  ["GET", "/emergency/insertions", async (body, params, query) =>
    emergency.listProposals({ approval_status: query.get("approval_status") || undefined })],
  ["GET", "/emergency/insertions/:id", async (body, params) => emergency.getProposal(params.id)],
  ["POST", "/emergency/insertions/:id/decision", async (body, params) =>
    emergency.decideEmergencyInsertion(params.id, body)],

  // 回执与重排
  ["POST", "/assignments/:id/receipts", async (body, params) =>
    receiptsService.recordReceipt({ ...body, assignment_ref: params.id })],
  ["GET", "/receipts", async (body, params, query) =>
    receiptsService.listReceipts({ order_ref: query.get("order_ref") || undefined })],
  ["POST", "/receipts/detect-late", async (body) => replanning.detectLateReceipts(body)],
  ["GET", "/replans", async () => replanning.listReplans()],

  // 分片与产品
  ["POST", "/assignments/:id/shards", async (body, params) => productsService.registerShard(params.id, body)],
  ["GET", "/assignments/:id/shards", async (body, params) => productsService.listShards(params.id)],
  ["POST", "/assignments/:id/assemble", async (body, params) => productsService.assembleProduct(params.id)],
  ["GET", "/products", async (body, params, query) =>
    productsService.listProducts({ order_ref: query.get("order_ref") || undefined })],
  ["GET", "/products/:ref/versions/:version", async (body, params) =>
    productsService.getProductVersion(params.ref, params.version)],
  ["POST", "/products/:ref/versions/:version/reprocess", async (body, params) =>
    productsService.reprocessProduct(params.ref, params.version, body.reason || "")],
  ["POST", "/products/:ref/versions/:version/withdraw", async (body, params) =>
    productsService.withdrawProduct(params.ref, params.version, body.reason || "")],
  ["POST", "/products/:ref/versions/:version/deliver", async (body, params) =>
    productsService.deliverProduct(params.ref, params.version)],

  // 事件与通知
  ["GET", "/events", async () => eventsService.listDomainEvents()],
  ["POST", "/notifications/:id/ack", async (body, params) => ({
    acknowledged: eventsService.acknowledgeNotification(params.id),
  })],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const patternParts = pattern.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (patternParts.length !== pathParts.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < patternParts.length; i += 1) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (patternParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }
  return null;
}

function createApp() {
  getDatabase(); // 启动即确保迁移完成
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const matched = matchRoute(request.method, url.pathname);
      if (!matched) {
        send(response, 404, { error: "not_found", message: `${request.method} ${url.pathname} 不存在` });
        return;
      }
      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : {};
      const result = await matched.handler(body, matched.params, url.searchParams);
      send(response, request.method === "POST" ? 201 : 200, result === undefined ? {} : result);
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ConflictError) {
        send(response, error.statusCode, { error: error.name, message: error.message, details: error.details || null });
      } else {
        send(response, 500, { error: "internal_error", message: error.message });
      }
    }
  });
}

module.exports = { createApp };
