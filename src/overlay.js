const C = 2 * Math.PI * 92;
const el = (id) => document.getElementById(id);
el("prog").setAttribute("stroke-dasharray", C);

let plan = []; // [{name, cue, seconds}]
let idx = 0;
let remaining = 0;
let total = 0;
let kind = "long";
let timer = null;

function setBody(theme) {
  document.body.className = ["slate", "aurora", "sunset", "forest", "mono"].includes(theme) ? theme : "slate";
}

function clockTick() {
  const d = new Date();
  el("clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render() {
  el("count").textContent = Math.ceil(remaining);
  el("prog").setAttribute("stroke-dashoffset", String(C * (1 - (total ? remaining / total : 0))));
}

function showStep() {
  const s = plan[idx];
  if (!s) return finish(false);
  el("name").textContent = s.name;
  el("cue").textContent = s.cue;
  el("steps").textContent = plan.length > 1 ? `${idx + 1} of ${plan.length}` : "";
  total = s.seconds;
  remaining = s.seconds;
  render();
}

function tick() {
  remaining -= 0.1;
  if (remaining <= 0) {
    idx++;
    if (idx >= plan.length) return finish(false);
    showStep();
  } else render();
}

function finish(skipped) {
  clearInterval(timer);
  timer = null;
  window.api.send("overlay:done", { kind, skipped });
}

el("skip").addEventListener("click", () => finish(true));
el("postpone").addEventListener("click", () => {
  clearInterval(timer);
  timer = null;
  window.api.send("overlay:postpone", { kind, mins: 5 });
});

window.api.on("overlay:show", (p) => {
  kind = p.kind;
  setBody(p.theme);
  el("kind").textContent = kind === "long" ? "Stretch Break" : "Eye Break";
  el("skip").classList.toggle("hidden", !p.allowSkip);
  el("postpone").classList.toggle("hidden", !p.allowSkip);

  if (kind === "long" && p.exercises && p.exercises.length) {
    plan = p.exercises.map((e) => ({ name: e.name, cue: e.cue, seconds: e.seconds }));
  } else {
    plan = [{
      name: kind === "long" ? "Stand & stretch" : "Look away — 20 ft",
      cue: kind === "long"
        ? "Stand up, roll your shoulders, move around and breathe."
        : "Rest your eyes: focus on something ~20 feet away and blink slowly.",
      seconds: p.durationSec || (kind === "long" ? 180 : 20),
    }];
  }
  idx = 0;
  showStep();
  clearInterval(timer);
  timer = setInterval(tick, 100);
});

clockTick();
setInterval(clockTick, 1000);
