const el = (id) => document.getElementById(id);
const body = document.body;
const figure = el("figure");
const C = 2 * Math.PI * 65;
el("ring").setAttribute("stroke-dasharray", C);
document.head.insertAdjacentHTML("beforeend", "<style>body.paused #figure *{animation-play-state:paused}</style>");

let routine = [];
let idx = 0;
let kind = "long";
let total = 0;
let remaining = 0;
let paused = false;
let switched = false;
let timer = null;
let voiceOn = true, soundOn = true, volume = 0.6;

const THEMES = ["slate", "aurora", "sunset", "forest", "mono"];

// ---- audio / voice --------------------------------------------------------
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
      g.gain.linearRampToValueAtTime((volume ?? 0.6) * 0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + 0.22);
    });
  } catch (_) {}
}
function speak(text) {
  if (!voiceOn) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.volume = volume ?? 0.7; u.rate = 1;
    speechSynthesis.speak(u);
  } catch (_) {}
}

// ---- rendering ------------------------------------------------------------
function setFigure(anim) { figure.className = "anim a-" + (anim || "done"); }
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
  el("side").textContent = (s.mode === "side" || s.mode === "reps") ? (first ? "Left side" : "Right side") : "";
}

// ---- playback -------------------------------------------------------------
function playStretch() {
  clearInterval(timer);
  const s = routine[idx];
  if (!s) return finish();
  setFigure(s.anim);
  el("name").textContent = s.name;
  el("cue").textContent = s.cue;
  sideLabel(s, true);
  total = s.total || s.seconds || 30;
  remaining = total;
  renderRing(); renderDots();
  el("steps").textContent = kind === "long" ? `Stretch ${idx + 1} of ${routine.length}` : "";

  if (kind === "micro") return runStretch(s); // no get-ready for the eye break
  // 3-2-1 get ready
  el("readyName").textContent = s.name;
  el("readyNum").textContent = "3";
  el("ready").classList.remove("hidden");
  speak(s.name);
  let n = 3;
  timer = setInterval(() => {
    if (paused) return;
    n--;
    if (n <= 0) { clearInterval(timer); el("ready").classList.add("hidden"); runStretch(s); }
    else el("readyNum").textContent = String(n);
  }, 800);
}

function runStretch(s) {
  clearInterval(timer);
  chime("start");
  speak(s.cue);
  switched = false;
  renderRing();
  timer = setInterval(() => {
    if (paused) return;
    remaining -= 1;
    if ((s.mode === "side" || s.mode === "reps") && !switched && remaining <= total / 2) {
      switched = true;
      sideLabel(s, false);
      chime("switch"); speak("Switch sides");
    }
    if (remaining <= 0) { clearInterval(timer); chime("done"); idx++; playStretch(); return; }
    renderRing();
  }, 1000);
}

function finish() {
  clearInterval(timer);
  setFigure("done");
  el("name").textContent = "All done 🎉";
  el("side").textContent = "";
  el("cue").textContent = "Nice work — back to it with a looser, taller spine.";
  el("count").textContent = "✓";
  el("ring").setAttribute("stroke-dashoffset", "0");
  [...el("dots").children].forEach((d) => (d.className = "done"));
  el("steps").textContent = "";
  document.querySelector(".controls").classList.add("hidden");
  document.querySelector(".endrow").classList.add("hidden");
  chime("done"); speak("All done. Nice work.");
  setTimeout(() => window.api.send("overlay:done", { kind, skipped: false }), 1900);
}

// ---- controls -------------------------------------------------------------
el("pause").addEventListener("click", () => {
  paused = !paused;
  el("pause").textContent = paused ? "Resume" : "Pause";
  body.classList.toggle("paused", paused);
  if (paused) speechSynthesis.cancel();
});
el("back").addEventListener("click", () => { idx = Math.max(0, idx - 1); playStretch(); });
el("skip").addEventListener("click", () => { idx++; playStretch(); });
el("postpone").addEventListener("click", () => { clearInterval(timer); speechSynthesis.cancel(); window.api.send("overlay:postpone", { kind, mins: 5 }); });
el("end").addEventListener("click", () => { clearInterval(timer); speechSynthesis.cancel(); window.api.send("overlay:done", { kind, skipped: true }); });

// ---- clock + show ---------------------------------------------------------
function clock() { el("clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
clock(); setInterval(clock, 1000);

window.api.on("overlay:show", (p) => {
  kind = p.kind;
  routine = p.routine || [];
  voiceOn = !!p.voice; soundOn = !!p.sound; volume = p.volume ?? 0.6;
  setTheme(p.theme);
  el("kind").textContent = kind === "long" ? "Stretch break" : "Eye break";
  const allow = p.allowSkip !== false;
  document.querySelector(".controls").classList.remove("hidden");
  document.querySelector(".endrow").classList.remove("hidden");
  el("back").classList.toggle("hidden", kind !== "long");
  el("skip").classList.toggle("hidden", kind !== "long" || !allow);
  el("postpone").classList.toggle("hidden", !allow);
  el("end").classList.toggle("hidden", !allow);
  idx = 0; paused = false; el("pause").textContent = "Pause"; body.classList.remove("paused");
  buildDots();
  playStretch();
});
