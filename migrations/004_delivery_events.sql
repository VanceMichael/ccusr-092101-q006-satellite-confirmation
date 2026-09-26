-- 执行回执、下传分片、汇聚产品版本、交付、订阅与领域事件

-- 执行回执：卫星对冻结分配的实际成像反馈（可能晚到）
CREATE TABLE IF NOT EXISTS execution_receipts (
    id              TEXT PRIMARY KEY,
    assignment_id   TEXT NOT NULL UNIQUE REFERENCES plan_assignments(id),
    source_ref      TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    result          TEXT NOT NULL,            -- imaged | failed
    expected_shards INTEGER NOT NULL DEFAULT 0, -- 预期下传分片总数
    occurred_at     TEXT NOT NULL,            -- 回执所述事实发生时间
    received_at     TEXT NOT NULL,            -- 服务收到时间（晚到判定依据）
    detail          TEXT NOT NULL DEFAULT '',
    UNIQUE(source_ref, source_sequence)
);

-- 下传数据分片：按校验摘要登记
CREATE TABLE IF NOT EXISTS data_shards (
    id              TEXT PRIMARY KEY,
    assignment_id   TEXT NOT NULL REFERENCES plan_assignments(id),
    shard_ref       TEXT NOT NULL,           -- 分片引用（不含真实身份）
    seq             INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    downlinked_at   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'downlinked', -- downlinked | superseded | withdrawn
    UNIQUE(assignment_id, shard_ref)
);
CREATE INDEX IF NOT EXISTS idx_shards_asg ON data_shards(assignment_id);

-- 汇聚产品：明确版本，由一组分片校验摘要构成
CREATE TABLE IF NOT EXISTS product_versions (
    id                TEXT PRIMARY KEY,
    product_ref       TEXT NOT NULL,          -- 同一逻辑产品的稳定引用
    version           INTEGER NOT NULL,
    order_id          TEXT NOT NULL REFERENCES orders(id),
    assignment_id     TEXT NOT NULL REFERENCES plan_assignments(id), -- 产品永久引用原计划
    plan_run_id       TEXT NOT NULL REFERENCES plan_runs(id),
    status            TEXT NOT NULL DEFAULT 'assembling',
    -- assembling | complete | reprocessing | withdrawn
    missing_shards    TEXT NOT NULL DEFAULT '[]',
    manifest          TEXT NOT NULL DEFAULT '[]', -- [{shard_ref, seq, sha256}]
    manifest_digest   TEXT NOT NULL DEFAULT '',   -- 清单整体摘要，版本身份
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE(product_ref, version)
);
CREATE INDEX IF NOT EXISTS idx_products_order ON product_versions(order_id);

-- 交付记录：产品版本交付给订单的交付对象
CREATE TABLE IF NOT EXISTS deliveries (
    id              TEXT PRIMARY KEY,
    order_id        TEXT NOT NULL REFERENCES orders(id),
    product_version_id TEXT NOT NULL REFERENCES product_versions(id),
    deliverable     TEXT NOT NULL,
    delivered_at    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'delivered', -- delivered | recalled
    recall_reason   TEXT NOT NULL DEFAULT '',
    UNIQUE(order_id, product_version_id)
);

-- 订阅方与可追踪状态通知（缺片、重处理、撤回等）
CREATE TABLE IF NOT EXISTS subscriptions (
    id           TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL REFERENCES orders(id),
    subscriber   TEXT NOT NULL,               -- 交付对象/订阅方引用
    created_at   TEXT NOT NULL,
    UNIQUE(order_id, subscriber)
);

CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL REFERENCES orders(id),
    product_ref  TEXT NOT NULL DEFAULT '',
    version      INTEGER,
    kind         TEXT NOT NULL, -- shard_missing | shard_arrived | version_assembled
                                 -- | reprocessing | version_complete | withdrawn | delivered
    payload      TEXT NOT NULL DEFAULT '{}',
    acked        INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_order ON notifications(order_id);

-- 订单时间线：所有状态变化、候选选择、改排、交付、归因均可追溯
CREATE TABLE IF NOT EXISTS order_timeline (
    id          TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders(id),
    event_type  TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeline_order ON order_timeline(order_id, created_at);

-- 统一领域事件（保留来源系统对事实的责任边界）
CREATE TABLE IF NOT EXISTS domain_events (
    id               TEXT PRIMARY KEY,
    source_ref       TEXT NOT NULL,
    source_sequence  INTEGER NOT NULL,
    event_kind       TEXT NOT NULL,
    payload          TEXT NOT NULL DEFAULT '{}',
    occurred_at      TEXT NOT NULL,
    recorded_at      TEXT NOT NULL,
    UNIQUE(source_ref, source_sequence)
);
