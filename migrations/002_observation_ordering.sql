-- 观测订单编排服务：卫星目录、成像机会、订单登记、候选计划、
-- 冻结排期与插单批准、重排队列、数据分片/版本/订阅、订单事件时间线。
-- 所有外部主体使用引用编号；时间统一保存带偏移量的 ISO 8601 字符串。

-- 来源事件去重：外部事实必须携带来源系统与来源序列号，保留责任边界
CREATE TABLE IF NOT EXISTS inbound_event (
    source_ref      TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    event_kind      TEXT NOT NULL,
    payload_hash    TEXT NOT NULL,
    accepted_at     TEXT NOT NULL,
    PRIMARY KEY (source_ref, source_sequence)
);

-- 卫星及其能力版本
CREATE TABLE IF NOT EXISTS spacecraft (
    spacecraft_ref       TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    capability_version   TEXT NOT NULL,
    supported_modes      TEXT NOT NULL,            -- JSON 数组：支持的成像模式
    onboard_ai           INTEGER NOT NULL DEFAULT 0,
    storage_capacity_mb  INTEGER NOT NULL,
    energy_capacity_wh   INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'available', -- available | unavailable
    status_reason        TEXT,
    updated_at           TEXT NOT NULL
);

-- 成像机会（预报），修订以新行接续，旧版本标记 superseded
CREATE TABLE IF NOT EXISTS imaging_opportunity (
    opportunity_id      TEXT PRIMARY KEY,
    spacecraft_ref      TEXT NOT NULL REFERENCES spacecraft(spacecraft_ref),
    forecast_version    TEXT NOT NULL,
    window_start        TEXT NOT NULL,
    window_end          TEXT NOT NULL,
    imaging_mode        TEXT NOT NULL,
    bbox                TEXT NOT NULL,             -- JSON [west, south, east, north]
    geometry            TEXT,                      -- GeoJSON，可空
    storage_budget_mb   INTEGER NOT NULL,
    energy_budget_wh    INTEGER NOT NULL,
    expected_receipt_by TEXT,
    revised_of          TEXT REFERENCES imaging_opportunity(opportunity_id),
    status              TEXT NOT NULL DEFAULT 'forecast', -- forecast | superseded | cancelled
    created_at          TEXT NOT NULL
);

-- 观测订单：统一登记目标范围、允许时间、成像模式、时效等级、交付对象与数据使用边界
CREATE TABLE IF NOT EXISTS observation_order (
    order_id            TEXT PRIMARY KEY,
    department          TEXT NOT NULL,
    target_name         TEXT NOT NULL,
    target_aliases       TEXT NOT NULL DEFAULT '[]', -- JSON 数组：同一目标的其他名称
    geometry            TEXT NOT NULL,              -- GeoJSON Polygon
    bbox                TEXT NOT NULL,              -- JSON [west, south, east, north]
    allowed_start       TEXT NOT NULL,
    allowed_end         TEXT NOT NULL,
    imaging_modes       TEXT NOT NULL,              -- JSON 数组
    timeliness          TEXT NOT NULL,              -- emergency | routine | refresh
    delivery_recipients TEXT NOT NULL,              -- JSON 数组：订阅方引用编号
    data_scope          TEXT NOT NULL,              -- 数据授权/使用边界代码
    data_usage_terms    TEXT,
    storage_mb          INTEGER NOT NULL,
    expected_shards     INTEGER,
    deadline            TEXT NOT NULL,
    status              TEXT NOT NULL,              -- registered | candidate | planned | frozen
                                                                -- in_execution | delivered | replanning | expired | merged
    merged_into         TEXT REFERENCES observation_order(order_id),
    created_at          TEXT NOT NULL
);

-- 目标名称别名索引：用于识别“同一目标、不同名称”的重复下单
CREATE TABLE IF NOT EXISTS target_alias (
    alias_key   TEXT NOT NULL COLLATE NOCASE,
    order_id    TEXT NOT NULL REFERENCES observation_order(order_id),
    target_name TEXT NOT NULL,
    data_scope  TEXT NOT NULL,
    PRIMARY KEY (alias_key, order_id)
);

-- 合并提示：只提示，不自动合并；跨授权范围标记为不可共享
CREATE TABLE IF NOT EXISTS merge_suggestion (
    suggestion_id   TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES observation_order(order_id),
    other_order_id  TEXT NOT NULL REFERENCES observation_order(order_id),
    match_kind      TEXT NOT NULL,                  -- alias_match | geometry_overlap
    overlap_ratio   REAL,
    scope_compatible INTEGER NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',   -- open | accepted | dismissed | blocked_scope
    created_at      TEXT NOT NULL,
    UNIQUE (order_id, other_order_id, match_kind)
);

-- 候选计划：订单 × 机会的可行性与评分明细
CREATE TABLE IF NOT EXISTS candidate_plan (
    candidate_id      TEXT PRIMARY KEY,
    order_id          TEXT NOT NULL REFERENCES observation_order(order_id),
    opportunity_id    TEXT NOT NULL REFERENCES imaging_opportunity(opportunity_id),
    spacecraft_ref    TEXT NOT NULL,
    feasible          INTEGER NOT NULL,
    score             REAL NOT NULL,
    rationale         TEXT NOT NULL,                -- JSON：各评分因子
    infeasible_reason TEXT,
    rank              INTEGER,
    generated_at      TEXT NOT NULL
);

-- 计划（草稿可重算，冻结后不可变）
CREATE TABLE IF NOT EXISTS plan (
    plan_id    TEXT PRIMARY KEY,
    status     TEXT NOT NULL,                       -- draft | frozen
    created_at TEXT NOT NULL,
    frozen_at  TEXT
);

CREATE TABLE IF NOT EXISTS plan_allocation (
    allocation_id              TEXT PRIMARY KEY,
    plan_id                    TEXT NOT NULL REFERENCES plan(plan_id),
    order_id                   TEXT NOT NULL REFERENCES observation_order(order_id),
    opportunity_id             TEXT NOT NULL REFERENCES imaging_opportunity(opportunity_id),
    spacecraft_ref             TEXT NOT NULL,
    imaging_mode               TEXT NOT NULL,
    storage_mb                 INTEGER NOT NULL,
    expected_shards            INTEGER,
    status                     TEXT NOT NULL,
    -- draft 为草稿占用（不参与排他）；scheduled | executing | receipt_confirmed 为“占用中”
    -- displaced | cancelled_unavailable | cancelled_revision | cancelled_late | failed 释放机会
    displaced_by_allocation_id TEXT REFERENCES plan_allocation(allocation_id),
    approval_id                TEXT,
    scheduled_at               TEXT NOT NULL,
    executed_at                TEXT,
    receipt_at                 TEXT
);
-- 冻结后同一成像机会在占用状态下只能被分配一次
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_allocation_opportunity
    ON plan_allocation(opportunity_id)
    WHERE status IN ('scheduled', 'executing', 'receipt_confirmed');

-- 应急插单等需批准动作：必须展示被挤出的订单并留存决定
CREATE TABLE IF NOT EXISTS approval_request (
    approval_id           TEXT PRIMARY KEY,
    kind                   TEXT NOT NULL,           -- emergency_insertion
    plan_id                TEXT NOT NULL REFERENCES plan(plan_id),
    order_id               TEXT NOT NULL REFERENCES observation_order(order_id),
    opportunity_id         TEXT NOT NULL REFERENCES imaging_opportunity(opportunity_id),
    spacecraft_ref         TEXT NOT NULL,
    displaced_allocations  TEXT NOT NULL,           -- JSON：被挤出分配及订单明细
    status                 TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    approver_ref           TEXT,
    note                   TEXT,
    created_at             TEXT NOT NULL,
    decided_at             TEXT
);

-- 重排队列：卫星不可用 / 机会预报修订 / 回执晚到，仅受影响订单进入
CREATE TABLE IF NOT EXISTS replan_state (
    order_id               TEXT PRIMARY KEY REFERENCES observation_order(order_id),
    trigger_kind           TEXT NOT NULL,           -- spacecraft_unavailable | opportunity_revised
                                                              -- receipt_late | receipt_failed | emergency_displaced
    trigger_ref            TEXT NOT NULL,
    previous_allocation_id TEXT,
    entered_at             TEXT NOT NULL,
    resolved_at            TEXT,
    new_allocation_id      TEXT
);

-- 下传分片
CREATE TABLE IF NOT EXISTS data_shard (
    shard_id        TEXT PRIMARY KEY,
    allocation_id   TEXT NOT NULL REFERENCES plan_allocation(allocation_id),
    order_id        TEXT NOT NULL REFERENCES observation_order(order_id),
    product_version INTEGER NOT NULL DEFAULT 1,
    shard_index     INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    size_mb         INTEGER NOT NULL,
    received_at     TEXT NOT NULL,
    UNIQUE (allocation_id, shard_index, product_version)
);

-- 汇聚产物版本：按有序分片校验摘要汇聚；保存原计划快照，计划后续改排不影响已交付引用
CREATE TABLE IF NOT EXISTS data_product_version (
    product_id            TEXT NOT NULL,
    version               INTEGER NOT NULL,
    order_id              TEXT NOT NULL REFERENCES observation_order(order_id),
    allocation_id         TEXT NOT NULL,
    source_plan_id        TEXT NOT NULL,            -- 原计划快照
    spacecraft_ref        TEXT NOT NULL,
    opportunity_id        TEXT NOT NULL,
    status                TEXT NOT NULL,            -- incomplete | assembled | withdrawn
    processing_recipe     TEXT NOT NULL DEFAULT 'standard-v1',
    aggregate_checksum    TEXT,
    shard_checksums       TEXT NOT NULL,            -- JSON：{index: checksum}
    missing_indices       TEXT NOT NULL DEFAULT '[]',
    superseded_by_version INTEGER,
    created_at            TEXT NOT NULL,
    assembled_at          TEXT,
    withdrawn_at          TEXT,
    withdraw_reason       TEXT,
    PRIMARY KEY (product_id, version)
);

-- 订阅方及其被授予的数据范围；跨授权范围的订阅与共享一律拒绝
CREATE TABLE IF NOT EXISTS data_subscriber (
    subscriber_ref TEXT PRIMARY KEY,
    granted_scopes TEXT NOT NULL,              -- JSON 数组：授权范围代码
    created_at     TEXT NOT NULL
);

-- 订阅关系：仅授权范围一致方可订阅
CREATE TABLE IF NOT EXISTS product_subscription (
    subscriber_ref TEXT NOT NULL,
    product_id     TEXT NOT NULL,
    order_id       TEXT NOT NULL,
    data_scope     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (subscriber_ref, product_id)
);

-- 可追踪的订阅状态通知：缺片 / 汇聚完成 / 重处理 / 撤回
CREATE TABLE IF NOT EXISTS product_notification (
    notification_id TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL,
    version         INTEGER NOT NULL,
    subscriber_ref  TEXT NOT NULL,
    kind            TEXT NOT NULL,                  -- shard_missing | assembled | reprocessed | withdrawn
    status          TEXT NOT NULL DEFAULT 'pending',-- pending | delivered | acked
    detail          TEXT,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT,
    acked_at        TEXT,
    UNIQUE (product_id, version, subscriber_ref, kind)
);

-- 订单事件时间线（只追加）：支撑“按订单解释”
CREATE TABLE IF NOT EXISTS order_event (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    TEXT NOT NULL REFERENCES observation_order(order_id),
    kind        TEXT NOT NULL,
    detail      TEXT NOT NULL DEFAULT '{}',         -- JSON
    actor_ref   TEXT,
    occurred_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_observation_ordering');
