const el = (id) => document.getElementById(id);
const body = document.body;
const C = 2 * Math.PI * 86;
el("ring").setAttribute("stroke-dasharray", C);

let routine = [];
let idx = 0;
let kind = "long";
let total = 0;
let remaining = 0;
let paused = false;
let switched = false;
let timer = null;
let soundOn = true, volume = 0.6;

const THEMES = ["slate", "aurora", "sunset", "forest", "mono"];

// ---- chime (subtle, optional) ---------------------------------------------
let actx = null;
function chime(type) {
  if (!soundOn) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const now = actx.currentTime;
    const seq = type === "switch" ? [660, 880] : type === "done" ? [523, 660, 784] : [784];
    seq.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t = now + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime((volume ?? 0.6) * 0.45, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + 0.22);
    });
  } catch (_) {}
}

// ---- rendering ------------------------------------------------------------
function setTheme(t) { body.className = THEMES.includes(t) ? t : "slate"; }
function buildDots() {
  const box = el("dots"); box.innerHTML = "";
  if (kind !== "long") return;
  routine.forEach(() => box.appendChild(document.createElement("i")));
}
function renderDots() {
  [...el("dots").children].forEach((d, k) => { d.className = k < idx ? "done" : k === idx ? "cur" : ""; });
}
function renderRing() {
  el("count").textContent = Math.ceil(Math.max(0, remaining));
  el("ring").setAttribute("stroke-dashoffset", String(C * (1 - (total ? remaining / total : 0))));
}
function sideLabel(s, first) {
  const sideEl = el("side");
  if (s.mode === "side" || s.mode === "reps") {
    sideEl.textContent = first ? "◀  Left side" : "Right side  ▶";
    sideEl.classList.remove("show");
    void sideEl.offsetWidth; // restart the pop animation on switch
    sideEl.classList.add("show");
  } else {
    sideEl.classList.remove("show");
    sideEl.textContent = "";
  }
}

// ---- playback -------------------------------------------------------------
function playStretch() {
  clearInterval(timer);
  const s = routine[idx];
  if (!s) return finish();
  el("name").textContent = s.name;
  el("cue").textContent = s.cue;
  sideLabel(s, true);
  total = s.total || s.seconds || 30;
  remaining = total;
  renderRing(); renderDots();
  el("steps").textContent = kind === "long" ? `Stretch ${idx + 1} of ${routine.length}` : "";
  switched = false;
  chime("start");
  timer = setInterval(() => {
    if (paused) return;
    remaining -= 1;
    if ((s.mode === "side" || s.mode === "reps") && !switched && remaining <= total / 2) {
      switched = true;
      sideLabel(s, false);
      chime("switch");
    }
    if (remaining <= 0) { clearInterval(timer); chime("done"); idx++; playStretch(); return; }
    renderRing();
  }, 1000);
}

function finish() {
  clearInterval(timer);
  el("name").textContent = "All done 🎉";
  el("side").textContent = "";
  el("cue").textContent = "Nice work — back to it with a looser, taller spine.";
  el("count").textContent = "✓";
  el("ring").setAttribute("stroke-dashoffset", "0");
  [...el("dots").children].forEach((d) => (d.className = "done"));
  el("steps").textContent = "";
  document.querySelector(".controls").classList.add("hidden");
  document.querySelector(".endrow").classList.add("hidden");
  chime("done");
  setTimeout(() => window.api.send("overlay:done", { kind, skipped: false }), 1500);
}

// ---- controls -------------------------------------------------------------
el("pause").addEventListener("click", () => {
  paused = !paused;
  el("pause").textContent = paused ? "Resume" : "Pause";
});
el("skip").addEventListener("click", () => { idx++; playStretch(); });
el("postpone").addEventListener("click", () => { clearInterval(timer); window.api.send("overlay:postpone", { kind, mins: 5 }); });
el("end").addEventListener("click", () => { clearInterval(timer); window.api.send("overlay:done", { kind, skipped: true }); });

// ---- clock + show ---------------------------------------------------------
function clock() { el("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
clock(); setInterval(clock, 1000);

window.api.on("overlay:show", (p) => {
  kind = p.kind;
  routine = p.routine || [];
  soundOn = !!p.sound; volume = p.volume ?? 0.6;
  setTheme(p.theme);
  el("kind").textContent = kind === "long" ? "Stretch break" : "Eye break";
  const allow = p.allowSkip !== false;
  document.querySelector(".controls").classList.remove("hidden");
  document.querySelector(".endrow").classList.remove("hidden");
  el("skip").classList.toggle("hidden", kind !== "long" || !allow);
  el("postpone").classList.toggle("hidden", !allow);
  el("end").classList.toggle("hidden", !allow);
  idx = 0; paused = false; el("pause").textContent = "Pause";
  buildDots();
  playStretch();
});
