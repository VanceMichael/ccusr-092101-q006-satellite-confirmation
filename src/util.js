
const crypto = require("node:crypto");

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}

function parseIso(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw httpError(400, "invalid_time", `${field} 必须是带偏移量的 ISO 8601 时间`);
  }
  return new Date(value);
}

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

// 时间区间重叠（半开区间）
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function bboxOf(geometry) {
  // 支持直接给 bbox，或 GeoJSON Polygon/MultiPolygon
  if (Array.isArray(geometry) && geometry.length === 4 && geometry.every((n) => typeof n === "number")) {
    return geometry.slice();
  }
  if (!geometry || geometry.type !== "Polygon" || !Array.isArray(geometry.coordinates)) {
    throw httpError(400, "invalid_geometry", "geometry 必须是 GeoJSON Polygon 或 4 元素 bbox");
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of geometry.coordinates) {
    for (const [x, y] of ring) {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    }
  }
  return [west, south, east, north];
}

// 以包围盒相交面积近似目标重叠；返回 [west,south,east,north] 交集或 null
function bboxIntersection(a, b) {
  const west = Math.max(a[0], b[0]);
  const south = Math.max(a[1], b[1]);
  const east = Math.min(a[2], b[2]);
  const north = Math.min(a[3], b[3]);
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

function bboxArea(box) {
  if (!box) return 0;
  return Math.max(0, (box[2] - box[0]) * (box[3] - box[1]));
}

// 目标 A 被 B 覆盖的比例（相对 A 自身面积）
function coverageRatio(targetBox, candidateBox) {
  const inter = bboxIntersection(targetBox, candidateBox);
  const area = bboxArea(targetBox);
  if (area === 0) return inter ? 1 : 0;
  return bboxArea(inter) / area;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null);
  if (missing.length > 0) {
    throw httpError(400, "missing_fields", `缺少必填字段：${missing.join(", ")}`, { missing });
  }
}

function asStringArray(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw httpError(400, "invalid_field", `${field} 必须是非空字符串数组`);
  }
  return value.slice();
}

function sha256OfParts(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) hash.update(part).update("\n");
  return hash.digest("hex");
}

module.exports = {
  nowIso,
  newId,
  parseIso,
  httpError,
  windowsOverlap,
  bboxOf,
  bboxIntersection,
  bboxArea,
  coverageRatio,
  requireFields,
  asStringArray,
  sha256OfParts,
};
