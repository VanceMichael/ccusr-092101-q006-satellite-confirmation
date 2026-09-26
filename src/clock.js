
// 统一时钟：生产环境取系统时间，测试可通过 setNow 固定/快进时间
let fixedNow = null;

function nowIso() {
  return fixedNow || new Date().toISOString();
}

function setNow(value) {
  fixedNow = value === null ? null : new Date(value).toISOString();
}

function nowMs() {
  return Date.parse(nowIso());
}

module.exports = { nowIso, nowMs, setNow };
