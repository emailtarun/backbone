const $ = (s) => document.querySelector(s);
const steps = [...document.querySelectorAll(".step")];
const TOTAL = steps.length;
let i = 0;
let calibrated = false;
let cameraFailed = false;
let cfg = {};

// build progress dots
const dots = $("#dots");
for (let k = 0; k < TOTAL; k++) {
  const d = document.createElement("i");
  dots.appendChild(d);
}
function paintDots() {
  [...dots.children].forEach((d, k) => d.classList.toggle("on", k <= i));
}

function show(n) {
  i = Math.max(0, Math.min(TOTAL - 1, n));
  steps.forEach((s) => s.classList.toggle("active", +s.dataset.step === i));
  $("#back").style.visibility = i === 0 ? "hidden" : "visible";
  const last = i === TOTAL - 1;
  $("#next").textContent = i === 0 ? "Get started" : last ? "Finish" : "Next";
  // Skip is only meaningful on optional steps (camera/calibrate/breaks/watch)
  $("#skip").style.visibility = i === 0 || last ? "hidden" : "visible";
  // gate Next on the calibrate step until calibrated (or the camera failed)
  $("#next").disabled = i === 2 && !calibrated && !cameraFailed;
  // show the live camera window only while calibrating
  window.api.send("setup:showCamera", i === 2);
  paintDots();
}

$("#next").addEventListener("click", () => (i === TOTAL - 1 ? finish() : show(i + 1)));
$("#back").addEventListener("click", () => show(i - 1));
$("#skip").addEventListener("click", (e) => { e.preventDefault(); show(i + 1); });

function finish() {
  window.api.send("setup:done");
}

// ---- camera ---------------------------------------------------------------
$("#enableCam").addEventListener("click", () => {
  window.api.send("setup:setMonitoring", true);
  setStatus("camStatus", "camText", "warn", "Starting camera… allow access if macOS asks.");
  $("#camPickCard").style.display = "block";
});

function populateCameras({ cameras, active }) {
  if (!cameras || !cameras.length) return;
  const sel = $("#cameraId");
  const chosen = cfg.cameraId || active || "";
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = ""; def.textContent = "System default";
  sel.appendChild(def);
  cameras.forEach((c) => {
    const o = document.createElement("option");
    o.value = c.id; o.textContent = c.label;
    if (c.id === chosen) o.selected = true;
    sel.appendChild(o);
  });
}
window.api.on("cameras:list", populateCameras);
$("#cameraId").addEventListener("change", (e) => {
  cfg.cameraId = e.target.value;
  window.api.invoke("settings:set", { cameraId: e.target.value });
});
$("#wideFov").addEventListener("change", (e) => window.api.invoke("settings:set", { wideFov: e.target.checked }));

// ---- live status (the camera window handles calibration itself) -----------
window.api.on("setup:posture", ({ state, pos }) => {
  if (state === "no-person")
    setStatus("camStatus", "camText", "warn", "Camera on - but I can't see you. Sit in frame.");
  else setStatus("camStatus", "camText", "ok", "Camera on - I can see you ✓");
  if (pos && !calibrated) {
    const msg = pos.ready
      ? "In position - press Calibrate on the camera window"
      : !pos.inFrame
      ? "Fill the camera guide with your head & shoulders"
      : !pos.level
      ? "Level your shoulders"
      : "Center yourself in the frame";
    setStatus("calStatus", "calText", pos.ready ? "ok" : "warn", msg);
  }
});

window.api.on("setup:cameraError", (msg) => {
  cameraFailed = true;
  setStatus("camStatus", "camText", "warn", "Camera unavailable: " + (msg || "no signal"));
  setStatus("calStatus", "calText", "warn", "You can continue and calibrate later from the menu bar.");
  if (i === 2) $("#next").disabled = false;
});

window.api.on("setup:calibrated", (deskCheck) => {
  calibrated = true;
  const warnings = renderDeskCheck(deskCheck);
  setStatus("calStatus", "calText", "ok", warnings ? "Calibrated ✓ - one desk tweak worth making:" : "Calibrated ✓ - moving on…");
  if (i === 2) {
    $("#next").disabled = false;
    // If the desk check flagged something, stay so they can read it; else move on.
    if (!warnings) setTimeout(() => { if (i === 2) show(3); }, 1500);
  }
});

// Webcam-estimated ergonomic check against OSHA/Cornell targets. Returns the
// number of warnings so the caller can decide whether to pause on this step.
function renderDeskCheck(dc) {
  const box = $("#deskCheck"), list = $("#deskCheckList");
  if (!dc || !box) return 0;
  const items = [];
  if (dc.distanceIn != null) {
    items.push(dc.tooClose
      ? ["warn", `You're sitting ≈${dc.distanceIn}″ from the screen - guidelines say at least 20″ (20–40″ is ideal). Push the screen back or scoot back a touch.`]
      : ["ok", `Screen distance ≈${dc.distanceIn}″ - within the recommended 20–40″.`]);
  }
  items.push(dc.cameraBelow
    ? ["warn", "Your camera (likely your screen) sits below eye level - raise the display so the top of the screen is at eye level; your neck will thank you."]
    : ["ok", "Screen height looks good - top of screen near eye level."]);
  items.push(dc.cameraOffCentre
    ? ["warn", "Camera is off to one side - if that's your main screen, put it directly in front of you to avoid twisting."]
    : ["ok", "Screen is straight ahead of you."]);
  items.push(["info", "Also worth a glance: forearms level with the desk (~90–100° elbow), feet flat, ears over shoulders."]);
  list.innerHTML = "";
  let warnings = 0;
  for (const [kind, text] of items) {
    if (kind === "warn") warnings++;
    const li = document.createElement("li");
    li.textContent = (kind === "warn" ? "⚠️ " : kind === "ok" ? "✓ " : "💡 ") + text;
    if (kind === "warn") li.style.color = "#b45309";
    list.appendChild(li);
  }
  box.style.display = "";
  return warnings;
}

// ---- breaks ---------------------------------------------------------------
["microEnabled", "longEnabled", "standEnabled"].forEach((id) =>
  $("#" + id).addEventListener("change", (e) => {
    window.api.invoke("settings:set", { [id]: e.target.checked });
    if (id === "standEnabled") $("#standIntervalRow").style.display = e.target.checked ? "" : "none";
  })
);
["microIntervalMin", "longIntervalMin", "standIntervalMin"].forEach((id) =>
  $("#" + id).addEventListener("change", (e) => window.api.invoke("settings:set", { [id]: Number(e.target.value) }))
);

// ---- watch / ntfy ---------------------------------------------------------
$("#bugReports").addEventListener("change", (e) => window.api.invoke("settings:set", { bugReports: e.target.checked }));
$("#watchEnabled").addEventListener("change", (e) => window.api.invoke("settings:set", { watchEnabled: e.target.checked }));
$("#watchTopic").addEventListener("change", (e) => window.api.invoke("settings:set", { watchTopic: e.target.value }));
$("#genTopic").addEventListener("click", () => {
  const topic = "posture-" + Math.random().toString(36).slice(2, 10);
  $("#watchTopic").value = topic;
  $("#watchEnabled").checked = true;
  window.api.invoke("settings:set", { watchTopic: topic, watchEnabled: true });
});
$("#testWatch").addEventListener("click", () => {
  setStatus("watchStatus", "watchText", "warn", "Sending test buzz…");
  $("#watchStatus").style.display = "flex";
  window.api.send("watch:test");
});
window.api.on("watch:testResult", ({ ok, detail }) => {
  $("#watchStatus").style.display = "flex";
  if (ok) setStatus("watchStatus", "watchText", "ok", "Sent ✓ - check your phone & Watch. No buzz? Make sure ntfy is subscribed to your topic.");
  else setStatus("watchStatus", "watchText", "warn", "Couldn't send: " + (detail || "unknown error"));
});

function setStatus(boxId, textId, cls, msg) {
  const box = $("#" + boxId);
  box.className = "status " + (cls || "");
  $("#" + textId).textContent = msg;
}

// ---- init -----------------------------------------------------------------
(async () => {
  cfg = await window.api.invoke("settings:get");
  $("#microEnabled").checked = !!cfg.microEnabled;
  $("#longEnabled").checked = !!cfg.longEnabled;
  $("#microIntervalMin").value = cfg.microIntervalMin;
  $("#longIntervalMin").value = cfg.longIntervalMin;
  $("#standEnabled").checked = !!cfg.standEnabled;
  $("#standIntervalMin").value = cfg.standIntervalMin;
  $("#standIntervalRow").style.display = cfg.standEnabled ? "" : "none";
  $("#watchEnabled").checked = !!cfg.watchEnabled;
  $("#watchTopic").value = cfg.watchTopic || "";
  $("#bugReports").checked = cfg.bugReports !== false;
  $("#wideFov").checked = cfg.wideFov !== false;
  const cams = await window.api.invoke("cameras:get");
  if (cams && cams.cameras && cams.cameras.length) {
    populateCameras(cams);
    $("#camPickCard").style.display = "block";
  }
  show(0);
})();
