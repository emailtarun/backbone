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
    setStatus("camStatus", "camText", "warn", "Camera on — but I can't see you. Sit in frame.");
  else setStatus("camStatus", "camText", "ok", "Camera on — I can see you ✓");
  if (pos && !calibrated) {
    const msg = pos.ready
      ? "In position — press Calibrate on the camera window"
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

window.api.on("setup:calibrated", () => {
  calibrated = true;
  setStatus("calStatus", "calText", "ok", "Calibrated ✓ — moving on…");
  if (i === 2) {
    $("#next").disabled = false;
    setTimeout(() => { if (i === 2) show(3); }, 1500); // auto-advance + closes the camera
  }
});

// ---- breaks ---------------------------------------------------------------
["microEnabled", "longEnabled"].forEach((id) =>
  $("#" + id).addEventListener("change", (e) => window.api.invoke("settings:set", { [id]: e.target.checked }))
);
["microIntervalMin", "longIntervalMin"].forEach((id) =>
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
  if (ok) setStatus("watchStatus", "watchText", "ok", "Sent ✓ — check your phone & Watch. No buzz? Make sure ntfy is subscribed to your topic.");
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
