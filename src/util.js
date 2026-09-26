
const crypto = require("node:crypto");
const { nowIso: clockNowIso } = require("./clock");

const TIMELINESS = Object.freeze({
  ROUTINE: "routine",
  URGENT: "urgent",
  EMERGENCY: "emergency",
});

const TIMELINESS_RANK = Object.freeze({ routine: 1, urgent: 2, emergency: 3 });

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.details = details;
  }
}

class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.details = details;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return clockNowIso();
}

function parseTime(value, field = "time") {
  if (typeof value !== "string") throw new ValidationError(`${field} 必须是 ISO 8601 字符串`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new ValidationError(`${field} 不是合法时间：${value}`);
  return value;
}

function assert(condition, message, details) {
  if (!condition) throw new ValidationError(message, details);
}

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${field} 取值必须为 ${allowed.join(" / ")} 之一，实际为 ${value}`);
  }
}

function normalizeBbox(bbox) {
  assert(Array.isArray(bbox) && bbox.length === 4, "bbox 必须是 [min_lon, min_lat, max_lon, max_lat]");
  const [minLon, minLat, maxLon, maxLat] = bbox.map((n) => Number(n));
  for (const n of [minLon, minLat, maxLon, maxLat]) assert(Number.isFinite(n), "bbox 坐标必须是数字");
  assert(minLon <= maxLon && minLat <= maxLat, "bbox 要求 min <= max");
  return { minLon, minLat, maxLon, maxLat };
}

function bboxIntersects(a, b) {
  return !(
    a.maxLon < b.minLon ||
    a.minLon > b.maxLon ||
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat
  );
}

function bboxContains(outer, inner) {
  return (
    inner.minLon >= outer.minLon &&
    inner.maxLon <= outer.maxLon &&
    inner.minLat >= outer.minLat &&
    inner.maxLat <= outer.maxLat
  );
}

// 相交面积占目标面积比例（经纬度平面近似，仅用于排序）
function coverageRatio(target, strip) {
  if (!bboxIntersects(target, strip)) return 0;
  const width = Math.min(target.maxLon, strip.maxLon) - Math.max(target.minLon, strip.minLon);
  const height = Math.min(target.maxLat, strip.maxLat) - Math.max(target.minLat, strip.minLat);
  const inter = Math.max(0, width) * Math.max(0, height);
  const targetArea = (target.maxLon - target.minLon) * (target.maxLat - target.minLat);
  return targetArea === 0 ? 1 : inter / targetArea;
}

function sha256Hex(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hoursBetween(aIso, bIso) {
  return (Date.parse(bIso) - Date.parse(aIso)) / 3_600_000;
}

module.exports = {
  TIMELINESS,
  TIMELINESS_RANK,
  ValidationError,
  ConflictError,
  NotFoundError,
  newId,
  nowIso,
  parseTime,
  assert,
  assertOneOf,
  normalizeBbox,
  bboxIntersects,
  bboxContains,
  coverageRatio,
  sha256Hex,
  hoursBetween,
};
