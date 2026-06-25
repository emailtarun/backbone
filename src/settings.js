let cfg = {};
const $ = (s) => document.querySelector(s);
const save = (patch) => window.api.invoke("settings:set", patch).then((s) => (cfg = s));

function sensWord(v) {
  v = Number(v);
  return v <= 25 ? "Gentle — only clear slouches" : v >= 75 ? "Strict — flags small drifts" : "Balanced";
}

// ---- generic data-key binding --------------------------------------------
function bindInputs() {
  document.querySelectorAll("[data-key]").forEach((inp) => {
    const key = inp.dataset.key;
    const evt = inp.type === "range" ? "input" : "change";
    inp.addEventListener(evt, () => {
      let v;
      if (inp.type === "checkbox") v = inp.checked;
      else if (inp.type === "number") v = Number(inp.value);
      else if (inp.type === "range") v = Number(inp.value);
      else if (inp.dataset.numeric != null) v = Number(inp.value);
      else v = inp.value;
      if (key === "sensitivity") $("#sensHint").textContent = sensWord(v);
      if (key === "soundVolume") $("#volHint").textContent = Math.round(v * 100) + "%";
      if (inp.type === "range" && evt === "input") {
        clearTimeout(inp._t);
        inp._t = setTimeout(() => save({ [key]: v }), 120);
      } else save({ [key]: v });
    });
  });
}

function fillInputs(s) {
  document.querySelectorAll("[data-key]").forEach((inp) => {
    const v = s[inp.dataset.key];
    if (inp.type === "checkbox") inp.checked = !!v;
    else inp.value = v;
  });
  $("#sensHint").textContent = sensWord(s.sensitivity);
  $("#volHint").textContent = Math.round(s.soundVolume * 100) + "%";
}

// ---- work days ------------------------------------------------------------
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
function renderDays(active) {
  const box = $("#days");
  box.innerHTML = "";
  DAYS.forEach((d, i) => {
    const b = document.createElement("button");
    b.textContent = d;
    b.className = active.includes(i) ? "on" : "";
    b.addEventListener("click", () => {
      const set = new Set(cfg.workDays);
      set.has(i) ? set.delete(i) : set.add(i);
      const arr = [...set].sort();
      cfg.workDays = arr;
      b.className = arr.includes(i) ? "on" : "";
      save({ workDays: arr });
    });
    box.appendChild(b);
  });
}

// ---- exercises ------------------------------------------------------------
function renderExercises(list) {
  const box = $("#exList");
  box.innerHTML = "";
  list.forEach((ex, i) => {
    const row = document.createElement("div");
    row.className = "ex-row";
    row.innerHTML =
      `<input class="name" value="${escapeHtml(ex.name)}" placeholder="Name" />` +
      `<input class="sec" type="number" min="5" max="300" value="${ex.seconds}" />` +
      `<input class="cue" value="${escapeHtml(ex.cue)}" placeholder="Instruction" />` +
      `<button class="del" title="Remove">✕</button>`;
    const commit = () => {
      cfg.exercises[i] = {
        name: row.querySelector(".name").value,
        seconds: Number(row.querySelector(".sec").value) || 30,
        cue: row.querySelector(".cue").value,
      };
      save({ exercises: cfg.exercises });
    };
    row.querySelectorAll("input").forEach((inp) => inp.addEventListener("change", commit));
    row.querySelector(".del").addEventListener("click", () => {
      cfg.exercises.splice(i, 1);
      save({ exercises: cfg.exercises });
      renderExercises(cfg.exercises);
    });
    box.appendChild(row);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

$("#addEx").addEventListener("click", () => {
  cfg.exercises.push({ name: "New stretch", seconds: 30, cue: "Describe the movement." });
  save({ exercises: cfg.exercises });
  renderExercises(cfg.exercises);
});
$("#resetEx").addEventListener("click", async () => {
  cfg.exercises = await window.api.invoke("settings:resetExercises");
  renderExercises(cfg.exercises);
});
$("#testLong").addEventListener("click", () => window.api.send("break:test", "long"));

// ---- apple watch / ntfy ---------------------------------------------------
$("#genTopic").addEventListener("click", () => {
  const rnd = Math.random().toString(36).slice(2, 10);
  const topic = "posture-" + rnd;
  const inp = document.querySelector('[data-key="watchTopic"]');
  inp.value = topic;
  cfg.watchTopic = topic;
  save({ watchTopic: topic });
});
$("#testWatch").addEventListener("click", () => window.api.send("watch:test"));

// ---- init -----------------------------------------------------------------
(async () => {
  cfg = await window.api.invoke("settings:get");
  fillInputs(cfg);
  bindInputs();
  renderDays(cfg.workDays || []);
  renderExercises(cfg.exercises || []);
})();
