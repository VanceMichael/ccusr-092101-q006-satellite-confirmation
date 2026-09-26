# 观测订单编排服务

PIESAT-2 多颗卫星入轨并具备星上智能处理能力后，统一登记应急观测、常规测绘、重复区域更新需求；结合每颗卫星的能力版本与成像机会生成候选计划、处理应急插单批准、在异常时最小化重排，并把下传分片汇聚成可追踪版本的数据产品。

服务通过 HTTP JSON 接口交换业务事件，使用 SQLite 文件保存本地状态。监听端口由 `PORT` 指定，数据文件位置由 `DATABASE_PATH` 指定（测试可用 `:memory:`）。`contracts/entities.json` 记录稳定字段，`docs/domain.md` 记录领域规则。

## 本地开发

```bash
make migrate   # 初始化/升级数据文件
make test      # 执行自动化检查（14 个端到端场景）
make run       # 启动服务
# 或
docker compose up --build   # 宿主机端口通过 APP_PORT 调整
```

## 一次完整业务链路

```bash
# 1) 订阅方授权（交付对象必须在订单授权范围内）
curl -s localhost:8080/subscribers -d '{"subscriber_ref":"sub-em","granted_scopes":["SCOPE-EM"]"}'

# 2) 卫星与能力版本（外部事实携带 source_ref/source_sequence）
curl -s "localhost:8080/spacecraft?source_ref=LEO-CONTROL&source_sequence=1" -d '{
  "spacecraft_ref":"PIESAT-2-A","name":"启明星甲","capability_version":"AI-2.1",
  "supported_modes":["optical","video"],"onboard_ai":true,
  "storage_capacity_mb":50000,"energy_capacity_wh":5000}'

# 3) 成像机会预报
curl -s localhost:8080/opportunities -d '{
  "opportunity_id":"OPT-A1","spacecraft_ref":"PIESAT-2-A","forecast_version":"fv-1",
  "window_start":"2026-10-01T01:00:00Z","window_end":"2026-10-01T01:30:00Z",
  "imaging_mode":"optical","footprint":[116.3,39.8,116.5,40.0],
  "storage_budget_mb":4000,"energy_budget_wh":2000,
  "expected_receipt_by":"2026-10-01T04:00:00Z"}'

# 4) 订单统一登记（响应中带重复目标合并提示）
curl -s localhost:8080/orders -d @fixtures/example.json

# 5) 候选计划 → 草稿 → 冻结
curl -s -X POST localhost:8080/orders/ORD-EM-1/candidates
curl -s -X POST localhost:8080/plans/draft -d '{"order_ids":["ORD-EM-1"]}'
curl -s -X POST localhost:8080/plans/<plan_id>/freeze

# 6) 应急插单：先看被挤出订单，再批准
curl -s -X POST localhost:8080/orders/ORD-EM-1/emergency-insertion -d '{"opportunity_id":"OPT-A1"}'
curl -s -X POST localhost:8080/approvals/<approval_id>/approve -d '{"approver_ref":"duty-director-7"}'

# 7) 异常 → 仅受影响订单重排
curl -s -X POST "localhost:8080/spacecraft/PIESAT-2-C/unavailable?source_ref=LEO-CONTROL&source_sequence=10" -d '{"reason":"姿态异常"}'
curl -s -X POST localhost:8080/replanning/run

# 8) 分片汇聚与订阅状态
curl -s localhost:8080/products/shards -d '{"allocation_id":"<alc>","shard_index":0,"checksum_sha256":"<64hex>","size_mb":400}'
curl -s "localhost:8080/notifications?subscriber_ref=sub-em"

# 9) 按订单解释：为何选星、改排经历、交付版本、超期责任
curl -s localhost:8080/orders/ORD-EM-1/explain
```

## 接口一览

| 方法 & 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /subscribers` | 登记订阅方及其授权范围 |
| `POST /spacecraft` `GET /spacecraft[/:ref]` | 卫星目录与能力版本 |
| `PUT /spacecraft/:ref/capability` | 能力版本升级（旧计划引用旧事实） |
| `POST /spacecraft/:ref/unavailable` `/available` | 卫星不可用/恢复（触发局部重排） |
| `POST /opportunities` `GET /opportunities/:id` | 成像机会预报 |
| `POST /opportunities/:id/revise` | 预报修订（旧机会作废、局部重排） |
| `POST /orders` `GET /orders[/:id]` | 订单统一登记与查询 |
| `GET /orders/:id/candidates` `POST /orders/:id/candidates` | 查询/生成候选计划与评分 |
| `GET /orders/:id/explain` | 选星原因、改排经历、交付与超期责任 |
| `GET /merge-suggestions` | 重复目标合并提示 |
| `POST /merge-suggestions/:id/accept` `/dismiss` | 接受（跨授权范围会被拒）/忽略提示 |
| `POST /plans/draft` `GET /plans/:id` `POST /plans/:id/freeze` | 草稿、查询、冻结（机会排他生效） |
| `POST /orders/:id/emergency-insertion` | 发起应急插单，返回被挤出订单与批准单 |
| `GET /approvals[/:id]` `POST /approvals/:id/approve` `/reject` | 批准留痕（必须有 approver_ref） |
| `GET /replanning` `POST /replanning/run` | 重排队列与一次性再冻结 |
| `POST /allocations/:id/receipt` | 执行回执 `executed/failed/receipt_confirmed` |
| `POST /allocations/:id/late` | 回执晚到判定（已交付不重排） |
| `POST /products/subscribe` | 按授权范围订阅产品 |
| `POST /products/shards` | 下传分片（校验摘要，自动汇聚） |
| `POST /products/missing-check` | 显式缺片检查与通知 |
| `POST /products/reprocess` `/withdraw` | 重处理新版本 / 撤回版本 |
| `GET /products/:id` | 产品全部版本与聚合摘要 |
| `GET /notifications` `POST /notifications/:id/ack` | 订阅状态通知查询与确认 |

## 关键规则

- **重复下单**：别名归一化 + 几何覆盖识别同一目标；只提示合并。不同 `data_scope` 不得共享，跨范围合并返回 `403 scope_crosses_boundary`。
- **机会排他**：冻结后同一机会唯一占用，冲突冻结返回 `409 opportunity_already_allocated`。
- **应急插单**：不批准不执行；批准时若出现未展示的新占用返回 `409 occupancy_changed`。
- **局部重排**：卫星不可用、机会修订、回执晚到只让受影响订单进入重排；已交付产品继续引用原计划。
- **数据版本**：分片按摘要汇聚，缺片/汇聚/重处理/撤回均向订阅方产生去重且可确认的通知；同序号不同摘要返回 `409 shard_checksum_conflict`。

所有错误响应为 `{ "error": "<code>", "message": "...", "details": {...} }`。
