
const http = require("node:http");
const { openDatabase } = require("./db");
const { registerRoutes, dispatch } = require("./routes");

registerRoutes();

function createServer(options = {}) {
  const db = options.db || openDatabase(options.databasePath);

  const server = http.createServer((request, response) => {
    handle(request, response, db).catch((error) => {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        error: error.code || "internal_error",
        message: status >= 500 ? "服务内部错误" : error.message,
        details: error.details,
      });
    });
  });

  server.on("close", () => {
    if (!options.db) db.close();
  });

  return server;
}

async function handle(request, response, db) {
  const url = new URL(request.url, "http://localhost");
  const query = Object.fromEntries(url.searchParams.entries());

  let body = null;
  if (request.method === "POST" || request.method === "PUT") {
    const raw = await readBody(request);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(response, 400, { error: "invalid_json", message: "请求体必须是合法 JSON" });
        return;
      }
    }
  }

  const result = dispatch(db, request.method, url.pathname, body, query);
  sendJson(response, 200, result);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(Object.assign(new Error("请求体过大"), { status: 413, code: "payload_too_large" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`观测订单编排服务监听 ${port}`);
  });
}

module.exports = { createServer };
