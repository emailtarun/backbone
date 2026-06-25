const el = (id) => document.getElementById(id);
const pct = (v) => (v == null ? "—" : v + "%");
const color = (v) => (v == null ? "#8e8e93" : v >= 75 ? "#34c759" : v >= 50 ? "#ffcc00" : "#ff6b5e");

function barChart(data) {
  const W = 640, H = 150, pad = 24, n = data.length;
  const bw = (W - pad * 2) / n;
  let bars = "";
  data.forEach((d, i) => {
    const h = d.pct == null ? 0 : (d.pct / 100) * (H - 40);
    const x = pad + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const y = H - 22 - h;
    const day = new Date(d.day + "T00:00:00").toLocaleDateString([], { weekday: "short" });
    bars += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${color(d.pct)}"></rect>`;
    bars += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${day}</text>`;
    if (d.pct != null) bars += `<text x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${d.pct}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    <line class="grid" x1="${pad}" y1="${H - 22}" x2="${W - pad}" y2="${H - 22}" stroke="#ddd"/>${bars}</svg>`;
}

function sparkline(series) {
  const W = 640, H = 90, pad = 8;
  const pts = series.filter((s) => s.pct != null);
  if (pts.length < 2) return `<div style="opacity:.5;font-size:12px;padding:8px 0">Not enough data yet — keep sitting.</div>`;
  const xs = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (v / 100) * (H - pad * 2);
  let d = "";
  pts.forEach((p, i) => (d += `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.pct).toFixed(1)} `));
  const area = d + `L${xs(pts.length - 1)},${H - pad} L${xs(0)},${H - pad} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    <path d="${area}" fill="rgba(52,199,89,.15)"/>
    <path d="${d}" fill="none" stroke="#34c759" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

async function refresh() {
  const s = await window.api.invoke("stats:get");
  el("streak").textContent = s.streak;
  el("todayPct").textContent = pct(s.todayPct);
  el("todayPct").style.color = color(s.todayPct);
  el("goodMin").textContent = s.goodMin;
  el("breaks").textContent = s.micros + s.longs;
  el("week").innerHTML = barChart(s.week);
  const wk = s.week.filter((d) => d.pct != null);
  el("weekAvg").textContent = wk.length ? "avg " + Math.round(wk.reduce((a, d) => a + d.pct, 0) / wk.length) + "%" : "";
  el("spark").innerHTML = sparkline(s.last5.series);
  el("nowPct").textContent = s.last5.pct == null ? "" : "now " + s.last5.pct + "%";
  el("detail").textContent =
    `${s.micros} eye breaks · ${s.longs} stretch breaks · ${s.skipped} skipped · ${s.badMin} min slouching today`;
}

refresh();
setInterval(refresh, 4000);
