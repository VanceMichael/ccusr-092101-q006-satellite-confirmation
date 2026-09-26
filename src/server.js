
const { createApp } = require("./app");

// 保持原有 createServer 接口：创建完整编排服务（/health 及全部业务端点）
function createServer() {
  return createApp();
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0", () => {
    console.log(`观测订单编排服务已启动，端口 ${port}`);
  });
}

module.exports = { createServer };
