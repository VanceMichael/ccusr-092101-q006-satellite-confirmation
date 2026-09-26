
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { setDatabase, openDatabase } = require("../src/db");
const { createApp } = require("../src/app");

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function setupContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  const databasePath = path.join(dir, "test.sqlite3");
  setDatabase(openDatabase(databasePath));
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, urlPath, body) {
    const response = await fetch(base + urlPath, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, body: json };
  }
  const post = (urlPath, body) => request("POST", urlPath, body);
  const get = (urlPath) => request("GET", urlPath);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    require("../src/clock").setNow(null);
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { base, post, get, close, databasePath };
}

// 标准四星阵容：13/14/15 具备星上智能处理，16 为旧能力版本
async function seedFleet(post) {
  const spacecrafts = [
    { ref: "PIESAT-2-13", name: "13星", capability_version: "2.3.0", supported_modes: ["optical_hr", "video"], onboard_intelligence: true },
    { ref: "PIESAT-2-14", name: "14星", capability_version: "2.3.0", supported_modes: ["optical_hr", "sar"], onboard_intelligence: true },
    { ref: "PIESAT-2-15", name: "15星", capability_version: "2.1.0", supported_modes: ["optical_hr"], onboard_intelligence: true },
    { ref: "PIESAT-2-16", name: "16星", capability_version: "1.5.0", supported_modes: ["optical_hr"], onboard_intelligence: false },
  ];
  for (const sc of spacecrafts) {
    await post("/spacecraft", sc);
  }
  return spacecrafts;
}

module.exports = { setupContext, seedFleet, sha256 };
