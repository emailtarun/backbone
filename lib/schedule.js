// Pure helpers for working-hours / quiet-hours logic.

function parseHM(str) {
  const [h, m] = String(str || "0:0").split(":").map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

function nowMinutes(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

// Returns true if `now` falls inside [start,end], handling overnight wraps
// (e.g. quiet hours 22:00 -> 08:00).
function inWindow(startStr, endStr, d = new Date()) {
  const start = parseHM(startStr);
  const end = parseHM(endStr);
  const now = nowMinutes(d);
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end; // overnight
}

// Is the current moment within configured working hours / days?
function isWorkingNow(cfg, d = new Date()) {
  if (!cfg.workingHoursEnabled) return true;
  const day = d.getDay(); // 0=Sun
  if (Array.isArray(cfg.workDays) && !cfg.workDays.includes(day)) return false;
  return inWindow(cfg.workStart, cfg.workEnd, d);
}

function isQuietNow(cfg, d = new Date()) {
  if (!cfg.quietHoursEnabled) return false;
  return inWindow(cfg.quietStart, cfg.quietEnd, d);
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

module.exports = { parseHM, inWindow, isWorkingNow, isQuietNow, todayKey, nowMinutes };
