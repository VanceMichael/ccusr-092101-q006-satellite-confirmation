-- 观测订单编排服务：主数据（卫星能力版本、目标、授权范围）

CREATE TABLE IF NOT EXISTS spacecraft (
    id                 TEXT PRIMARY KEY,
    ref                TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    capability_version TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'available', -- available | unavailable
    metadata_json      TEXT NOT NULL DEFAULT '{}',
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
    id                 TEXT PRIMARY KEY,
    ref                TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    -- GeoJSON 经纬度包围盒 [min_lon, min_lat, max_lon, max_lat]
    bbox               TEXT NOT NULL,
    bbox_min_lon       REAL NOT NULL,
    bbox_min_lat       REAL NOT NULL,
    bbox_max_lon       REAL NOT NULL,
    bbox_max_lat       REAL NOT NULL,
    created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_aliases (
    id         TEXT PRIMARY KEY,
    target_id  TEXT NOT NULL REFERENCES targets(id),
    alias      TEXT NOT NULL,
    UNIQUE(target_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_target_aliases_alias ON target_aliases(alias);

-- 授权范围（数据使用边界）：同一目标可被多个部门分别授权
CREATE TABLE IF NOT EXISTS authorization_scopes (
    id          TEXT PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    owner_dept  TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS target_scopes (
    target_id      TEXT NOT NULL REFERENCES targets(id),
    scope_code     TEXT NOT NULL REFERENCES authorization_scopes(code),
    PRIMARY KEY(target_id, scope_code)
);
