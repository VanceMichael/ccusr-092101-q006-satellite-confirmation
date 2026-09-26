# 领域约定：多星观测订单编排

PIESAT-2 四星（以引用编号表示）入轨并具备星上智能处理能力后，应急观测、常规测绘与重复区域更新需求统一进入本服务编排。外部主体一律使用不含真实身份信息的引用编号，时间采用带偏移量的 ISO 8601 字符串，附件只记录受控引用或 `sha256` 摘要；业务事件携带来源 `source_ref` 与 `source_sequence`，保留来源系统对事实的责任边界。

## 核心对象

- **卫星（spacecraft）**：按能力版本（`capability_version`）登记，能力包括支持的成像模式集合与是否具备星上智能处理（`onboard_intelligence`）。状态为 `available` / `unavailable`。
- **目标（target）**：经纬度包围盒、正式名称与别名集合。不同部门以不同名称下单同一目标时，依靠名称/别名解析识别为同一目标。
- **授权范围（authorization scope）**：数据使用边界。目标可同时挂多个范围；订单必须声明一个范围。
- **订单（order）**：统一登记目标范围、允许成像时间窗、成像模式、时效等级（routine / urgent / emergency）、交付对象、数据使用边界，以及是否要求星上智能处理。
- **成像机会（opportunity）**：某颗星在一个时间窗内对某地理条带的可成像预报，含支持模式、能耗、存储成本与回执期限；预报可修订（产生新版本，旧版置 `revised`）或撤销。
- **候选（candidate）**：订单 × 机会的可行性判定与六项加权评分；不可行候选保留原因（模式不支持、时间窗外、覆盖不足、无星上智能、卫星不可用等）。
- **计划运行（plan run）与分配（assignment）**：候选经选择后，冻结为计划下的成像任务分配。

## 编排规则

### 重复下单与授权边界

1. 下单时按「同一目标（含别名）」与「几何包围盒相交」检测现存订单，返回 `duplicate_suggestions`。
2. 重叠**只提示**，不自动合并。任务经理可对同授权范围的重叠订单确认合并。
3. 授权范围不同（`sharing_blocked`）时禁止合并、禁止任何数据共享；应急、测绘等部门对同一目标的需求各自独立编排。

### 候选与选择

- 可行性：卫星可用、卫星与机会均支持所需模式、星上智能要求满足、机会在允许时间窗内、条带对目标覆盖率达到阈值（0.8）。
- 评分（选星理由可逐项追溯）：覆盖率 40、尽早成像 20、能耗效率 10、存储效率 10、能力版本 6、星上智能 4。
- 选择：按时效（emergency > urgent > routine）与截止时间排序逐单贪心挑选；`energy_budget` / `storage_budget` 限制总能耗与星上存储占用。无可行机会或预算不足的订单留在计划外并记录原因。

### 冻结与应急插单

- 计划冻结后分配生效。**同一成像机会在任何时刻最多存在一个有效分配**（数据库部分唯一索引兜底；挤出/取消仅释放机会、保留历史行）。
- 已冻结机会不再进入后续新计划的候选。
- 应急插单（`timeliness=emergency`）先生成提案：明确所选星/机会与**将被挤出的订单清单**。提案在批准前不改变任何计划。
- 批准必须携带 `approver_ref`；驳回则计划不变。批准后被挤订单置 `displaced_pending` 并立即进入仅针对它们的重排。

### 重排（仅影响受影响订单）

触发来源有三类，另有应急挤出与执行失败：

- `spacecraft_unavailable`：卫星不可用，仅依赖该星未完成分配的订单重排。
- `opportunity_revised` / 撤销：仅使用该机会的订单重排，修订后的新机会正常参与候选。
- `receipt_late`：机会窗口结束后超过 `receipt_due_after_minutes` 未收到回执，按未确认处理并触发重排。
- 迟到的回执只补记事实（`late_receipt_after_replan`），不撤销既成改排；其数据若下传，仍按原计划汇聚。
- **已交付（fulfilled）的订单与已交付产品版本不受重排影响**，产品永久引用原计划与原分配。

### 执行、汇聚与交付

- 执行回执按 `source_ref + source_sequence` 幂等登记，标记成功/失败、实际发生时间与收到时间（晚到可判定）。
- 下传分片按 `sha256` 摘要登记；重复上报摘要一致时幂等，摘要不一致被拒绝。
- 汇聚以「分片校验摘要清单的整体摘要」确定产品身份：清单相同命中同一版本，清单变化产生新版本。回执声明 `expected_shards`，缺片时版本为 `assembling` 并向订阅方发出 `shard_missing`；补齐后成为 `complete`。
- 仅完整版本可交付。重处理（`reprocessing`）与撤回（`withdrawn`，联动召回已交付记录）都向订单订阅方产生可追踪通知（`notifications`），可确认（ack）。

### 可追溯解释与超期归因

`GET /orders/:ref/explanation` 汇总：

- **为何选中某颗星**：生效分配所属计划的候选评分、六项明细与落选候选（含不可行原因）。
- **经历过哪些改排**：全部 `replans` 记录与订单时间线。
- **实际交付了什么**：产品版本、分片清单摘要与交付记录。
- **超期责任落在哪个环节**：对照订单截止时间，若存在改排则归因于最后一次触发环节（卫星可用 / 机会预报 / 执行回执 / 应急挤出）；否则按提交→排程→成像→下传→处理→交付的阶段区间定位。

## HTTP 接口概览

主数据：`POST/GET /spacecraft`、`POST /spacecraft/:ref/unavailable|available`、`POST/GET /scopes`、`POST/GET /targets`。
订单：`POST/GET /orders`、`GET /orders/:ref`、`POST /orders/:ref/merge|cancel`、`/explanation`、`/timeline`、`/notifications`、`/deliveries`、`/subscriptions`。
机会与计划：`POST/GET /opportunities`、`/opportunities/:id/revise|revoke`、`POST/GET /plan-runs`、`/plan-runs/:id/freeze`、`GET /assignments`。
应急：`POST/GET /emergency/insertions`、`/emergency/insertions/:id/decision`。
执行：`POST /assignments/:id/receipts|shards|assemble`、`POST /receipts/detect-late`、`GET /receipts|/replans`。
产品：`GET /products`、`POST /products/:ref/versions/:version/reprocess|withdraw|deliver`。
事件：`GET /events`、`POST /notifications/:id/ack`。
