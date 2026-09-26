# 多星观测订单编排服务

面向 PIESAT-2 四星入轨并具备星上智能处理能力后的观测业务：统一登记应急观测、常规测绘与重复区域更新需求，结合每颗卫星的能力版本与成像机会生成候选计划，处理重复下单、授权边界、应急插单审批、冻结后重排、数据分片汇聚与订单级可追溯解释。

服务通过 HTTP 接口交换业务事件，并使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定；`contracts/entities.json` 记录稳定字段与枚举，`fixtures/example.json` 提供不含真实身份信息的示例，完整领域规则见 `docs/domain.md`。

## 本地开发

运行 `make migrate` 初始化数据文件，`make test` 执行自动化检查（27 个端到端用例），`make run` 启动服务。也可以使用 `docker compose up --build` 构建并运行容器，宿主机端口通过 `APP_PORT` 调整。

## 一次完整链路

```bash
# 1. 主数据：卫星能力版本、授权范围、目标（含别名）
curl -s -XPOST localhost:8080/spacecraft -H 'content-type: application/json' \
  -d '{"ref":"PIESAT-2-13","name":"13星","capability_version":"2.3.0","supported_modes":["optical_hr"],"onboard_intelligence":true}'
curl -s -XPOST localhost:8080/scopes    -d '{"code":"SCOPE-BASE-MAPPING","owner_dept":"基础测绘部门"}'
curl -s -XPOST localhost:8080/targets   -d '{"ref":"TGT-RIVER-MOUTH","name":"河口断面","bbox":[110,30,111,31],"aliases":["河口监测区"],"scope_codes":["SCOPE-BASE-MAPPING"]}'

# 2. 成像机会与订单
curl -s -XPOST localhost:8080/opportunities -d '{"spacecraft_ref":"PIESAT-2-13","window_start":"2026-09-27T02:00:00Z","window_end":"2026-09-27T02:10:00Z","bbox":[109.5,29.5,111.5,31.5],"supported_modes":["optical_hr"]}'
curl -s -XPOST localhost:8080/orders -d '{"ref":"ORD-MAP-1","department":"基础测绘部门","requester_ref":"MAPPER-3","target_ref":"TGT-RIVER-MOUTH","scope_code":"SCOPE-BASE-MAPPING","imaging_mode":"optical_hr","timeliness":"routine","window_start":"2026-09-26T00:00:00Z","window_end":"2026-09-29T00:00:00Z","deadline_at":"2026-09-28T00:00:00Z","deliverable":"基础测绘成果库"}'

# 3. 候选 → 冻结（响应中的 selections 带逐项评分与选星理由）
RUN=$(curl -s -XPOST localhost:8080/plan-runs -d '{"energy_budget":20,"storage_budget":20}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -XPOST localhost:8080/plan-runs/$RUN/freeze

# 4. 应急插单：先看到被挤出的订单，批准后才生效
curl -s -XPOST localhost:8080/emergency/insertions -d '{"order_ref":"ORD-FIRE-1"}'
curl -s -XPOST localhost:8080/emergency/insertions/<提案id>/decision \
  -d '{"decision":"approve","approver_ref":"DUTY-MGR-2","note":"灾情优先"}'

# 5. 重排触发（仅影响对应订单）
curl -s -XPOST localhost:8080/spacecraft/PIESAT-2-13/unavailable -d '{"reason":"姿控异常"}'
curl -s -XPOST localhost:8080/receipts/detect-late -d '{"now":"2026-09-27T04:00:00Z"}'

# 6. 回执、分片、汇聚、交付
curl -s -XPOST localhost:8080/assignments/<分配id>/receipts -d '{"source_ref":"PIESAT-2-13","source_sequence":1,"result":"imaged","occurred_at":"2026-09-27T02:05:00Z","expected_shards":2}'
curl -s -XPOST localhost:8080/assignments/<分配id>/shards   -d '{"shard_ref":"S0","seq":0,"checksum_sha256":"<64位十六进制摘要>"}'
curl -s -XPOST localhost:8080/assignments/<分配id>/assemble
curl -s -XPOST localhost:8080/products/PRD-ORD-MAP-1/versions/1/deliver

# 7. 订单级解释：选星理由、改排经历、交付内容、超期责任环节
curl -s localhost:8080/orders/ORD-MAP-1/explanation
```

## 关键约束

- 计划冻结后同一成像机会只能分配一次（数据库部分唯一索引强制）。
- 目标重叠仅提示合并；不同授权范围不得合并或共享数据。
- 应急插单必须展示被挤出订单并取得批准人确认。
- 卫星不可用、机会预报修订、回执晚到只让受影响订单进入重排；已交付产品继续引用原计划。
- 缺片、重处理、撤回均向订阅方产生可追踪通知。
