-- 观测订单、成像机会、候选计划、冻结计划、应急插单与改排

CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    ref              TEXT NOT NULL UNIQUE,
    department       TEXT NOT NULL,           -- 提交部门
    requester_ref    TEXT NOT NULL,
    target_id        TEXT NOT NULL REFERENCES targets(id),
    target_name_live TEXT NOT NULL,           -- 下单时目标名称快照
    scope_code       TEXT NOT NULL REFERENCES authorization_scopes(code), -- 授权/使用边界
    imaging_mode     TEXT NOT NULL,
    require_onboard_processing INTEGER NOT NULL DEFAULT 0, -- 是否要求星上智能处理版本
    timeliness       TEXT NOT NULL,           -- routine | urgent | emergency
    window_start     TEXT NOT NULL,
    window_end       TEXT NOT NULL,
    deliverable      TEXT NOT NULL,           -- 交付对象
    usage_boundary   TEXT NOT NULL DEFAULT '',-- 数据使用边界自由文本
    status           TEXT NOT NULL DEFAULT 'submitted',
    -- submitted | candidate | planned | scheduled | displaced_pending
    --           | in_progress | fulfilled | closed | cancelled
    deadline_at      TEXT NOT NULL,           -- 时效要求最终期限（用于 SLA 判定）
    linked_to        TEXT REFERENCES orders(id), -- 合并提示后主订单（仅提示，需确认）
    duplicate_flags  TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_target ON orders(target_id);

CREATE TABLE IF NOT EXISTS imaging_opportunities (
    id             TEXT PRIMARY KEY,
    spacecraft_id  TEXT NOT NULL REFERENCES spacecraft(id),
    window_start   TEXT NOT NULL,
    window_end     TEXT NOT NULL,
    -- 机会覆盖的地理条带（bbox）
    bbox_min_lon   REAL NOT NULL,
    bbox_min_lat   REAL NOT NULL,
    bbox_max_lon   REAL NOT NULL,
    bbox_max_lat   REAL NOT NULL,
    supported_modes TEXT NOT NULL DEFAULT '[]',
    energy_cost      REAL NOT NULL DEFAULT 1,   -- 该机会成像预计能耗
    storage_cost     REAL NOT NULL DEFAULT 1,   -- 预计占用星上存储
    receipt_due_after_minutes INTEGER NOT NULL DEFAULT 60, -- 执行回执最迟到达滞后
    revision       INTEGER NOT NULL DEFAULT 1,  -- 预报修订版本
    status         TEXT NOT NULL DEFAULT 'forecast', -- forecast | revised | revoked | executed
    supersedes_id  TEXT REFERENCES imaging_opportunities(id),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_opps_sc ON imaging_opportunities(spacecraft_id);

CREATE TABLE IF NOT EXISTS plan_runs (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'planning', -- planning | emergency | replan
    status        TEXT NOT NULL DEFAULT 'open',     -- open | frozen
    reason        TEXT NOT NULL DEFAULT '',
    triggered_by  TEXT NOT NULL DEFAULT '',         -- 事件来源说明
    frozen_at     TEXT,
    created_at    TEXT NOT NULL
);

-- 候选计划：订单 × 机会的匹配与评分
CREATE TABLE IF NOT EXISTS plan_candidates (
    id               TEXT PRIMARY KEY,
    plan_run_id      TEXT NOT NULL REFERENCES plan_runs(id),
    order_id         TEXT NOT NULL REFERENCES orders(id),
    opportunity_id   TEXT NOT NULL REFERENCES imaging_opportunities(id),
    spacecraft_id    TEXT NOT NULL REFERENCES spacecraft(id),
    feasible         INTEGER NOT NULL DEFAULT 1,
    infeasible_reason TEXT NOT NULL DEFAULT '',
    coverage         REAL NOT NULL DEFAULT 0,
    score            REAL NOT NULL DEFAULT 0,
    score_breakdown  TEXT NOT NULL DEFAULT '{}',
    selected         INTEGER NOT NULL DEFAULT 0,
    UNIQUE(plan_run_id, order_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS idx_cand_order ON plan_candidates(order_id);

-- 冻结计划下的成像任务分配：同一机会在同一（或任何）冻结计划中只能出现一次
CREATE TABLE IF NOT EXISTS plan_assignments (
    id               TEXT PRIMARY KEY,
    plan_run_id      TEXT NOT NULL REFERENCES plan_runs(id),
    order_id         TEXT NOT NULL REFERENCES orders(id),
    opportunity_id   TEXT NOT NULL REFERENCES imaging_opportunities(id),
    spacecraft_id    TEXT NOT NULL REFERENCES spacecraft(id),
    seq              INTEGER NOT NULL DEFAULT 0,   -- 计划内顺序
    state            TEXT NOT NULL DEFAULT 'scheduled',
    -- scheduled | executing | imaged | failed | cancelled | displaced
    displaced_reason TEXT NOT NULL DEFAULT '',
    replaced_by_id   TEXT REFERENCES plan_assignments(id), -- 改排后新分配
    created_at       TEXT NOT NULL
);
-- 同一成像机会只能有一个处于有效状态的分配（挤出/取消后释放，历史行保留）
CREATE UNIQUE INDEX IF NOT EXISTS uq_asg_active_opportunity
    ON plan_assignments(opportunity_id)
    WHERE state IN ('scheduled', 'executing', 'imaged');
CREATE INDEX IF NOT EXISTS idx_asg_order ON plan_assignments(order_id);
CREATE INDEX IF NOT EXISTS idx_asg_run ON plan_assignments(plan_run_id);

-- 应急插单：记录被挤出的订单与审批
CREATE TABLE IF NOT EXISTS emergency_displacements (
    id                TEXT PRIMARY KEY,
    emergency_order_id TEXT NOT NULL REFERENCES orders(id),
    plan_run_id       TEXT NOT NULL REFERENCES plan_runs(id),
    chosen_opportunity_id TEXT REFERENCES imaging_opportunities(id),
    chosen_spacecraft_id  TEXT REFERENCES spacecraft(id),
    score_breakdown   TEXT NOT NULL DEFAULT '{}',
    displaced         TEXT NOT NULL DEFAULT '[]', -- [{assignment_id, order_id, opportunity_id, reason}]
    approval_status   TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    approver_ref      TEXT NOT NULL DEFAULT '',
    approved_at       TEXT,
    decision_note     TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disp_emergency ON emergency_displacements(emergency_order_id);

-- 改排记录：为什么改、影响了哪些订单、旧分配与新分配
CREATE TABLE IF NOT EXISTS replans (
    id               TEXT PRIMARY KEY,
    trigger_kind     TEXT NOT NULL, -- spacecraft_unavailable | opportunity_revised | receipt_late
    trigger_ref      TEXT NOT NULL, -- 卫星/机会/分配引用
    detail           TEXT NOT NULL DEFAULT '',
    affected_orders  TEXT NOT NULL DEFAULT '[]',
    old_assignments  TEXT NOT NULL DEFAULT '[]',
    new_assignments  TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL
);
