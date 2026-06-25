// Lightweight on-device stats: per-minute posture buckets + daily rollups,
// streaks, and aggregation for the dashboard. All numeric, no imagery.
const Store = require("electron-store");
const { todayKey } = require("./schedule");

const store = new Store({
  name: "stats",
  defaults: { minutes: [], days: {} },
});

const MAX_MINUTES = 2 * 24 * 60; // keep 2 days of fine-grained data
const MAX_DAYS = 400;

// current in-memory minute bucket
let cur = { minute: currentMinute(), good: 0, bad: 0, away: 0 };

function currentMinute() {
  return Math.floor(Date.now() / 60000);
}

// Record one posture sample. state: 'good' | 'bad' | 'no-person'
function sample(state) {
  const m = currentMinute();
  if (m !== cur.minute) flush();
  if (state === "good") cur.good++;
  else if (state === "bad") cur.bad++;
  else cur.away++;
}

function flush() {
  if (cur.good + cur.bad + cur.away > 0) {
    const minutes = store.get("minutes");
    minutes.push({ t: cur.minute, g: cur.good, b: cur.bad, a: cur.away });
    while (minutes.length > MAX_MINUTES) minutes.shift();
    store.set("minutes", minutes);

    // rough seconds estimate (~2 samples/sec) folded into the day rollup
    const days = store.get("days");
    const k = todayKey();
    const d = days[k] || { goodSec: 0, badSec: 0, awaySec: 0, micros: 0, longs: 0, skipped: 0 };
    d.goodSec += cur.good * 0.5;
    d.badSec += cur.bad * 0.5;
    d.awaySec += cur.away * 0.5;
    days[k] = d;
    pruneDays(days);
    store.set("days", days);
  }
  cur = { minute: currentMinute(), good: 0, bad: 0, away: 0 };
}

function pruneDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > MAX_DAYS) delete days[keys.shift()];
}

function bumpDay(field) {
  flush();
  const days = store.get("days");
  const k = todayKey();
  const d = days[k] || { goodSec: 0, badSec: 0, awaySec: 0, micros: 0, longs: 0, skipped: 0 };
  d[field] = (d[field] || 0) + 1;
  days[k] = d;
  store.set("days", days);
}

// Posture % over the last `mins` minutes from fine-grained buckets.
function recentScore(mins) {
  flush();
  const cutoff = currentMinute() - mins;
  const rows = store.get("minutes").filter((r) => r.t >= cutoff);
  let g = 0, b = 0;
  for (const r of rows) { g += r.g; b += r.b; }
  const series = rows.map((r) => ({
    t: r.t,
    pct: r.g + r.b > 0 ? Math.round((r.g / (r.g + r.b)) * 100) : null,
  }));
  return { pct: g + b > 0 ? Math.round((g / (g + b)) * 100) : null, series };
}

function dayKeysBack(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(todayKey(d));
  }
  return out;
}

// % good for each of the last `n` days.
function dailySeries(n) {
  const days = store.get("days");
  return dayKeysBack(n).map((k) => {
    const d = days[k];
    const tot = d ? d.goodSec + d.badSec : 0;
    return {
      day: k,
      pct: tot > 0 ? Math.round((d.goodSec / tot) * 100) : null,
      goodMin: d ? Math.round(d.goodSec / 60) : 0,
      micros: d ? d.micros || 0 : 0,
      longs: d ? d.longs || 0 : 0,
    };
  });
}

// Consecutive-day streak: days you used the app and held good posture a
// majority of the time, counting back from today (today optional).
function streak() {
  const days = store.get("days");
  let count = 0;
  for (let i = 0; i < MAX_DAYS; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const rec = days[todayKey(d)];
    const tot = rec ? rec.goodSec + rec.badSec : 0;
    const ok = tot > 60 && rec.goodSec / tot >= 0.5;
    if (ok) count++;
    else if (i === 0) continue; // today not yet qualified — don't break streak
    else break;
  }
  return count;
}

function summary() {
  flush();
  const today = store.get("days")[todayKey()] || { goodSec: 0, badSec: 0, micros: 0, longs: 0, skipped: 0 };
  const tot = today.goodSec + today.badSec;
  return {
    todayPct: tot > 0 ? Math.round((today.goodSec / tot) * 100) : null,
    goodMin: Math.round(today.goodSec / 60),
    badMin: Math.round(today.badSec / 60),
    micros: today.micros || 0,
    longs: today.longs || 0,
    skipped: today.skipped || 0,
    streak: streak(),
    last5: recentScore(5),
    today: recentScore(24 * 60),
    week: dailySeries(7),
  };
}

module.exports = { sample, bumpDay, summary, recentScore, dailySeries, streak, flush };
