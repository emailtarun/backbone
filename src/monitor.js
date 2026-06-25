import {
  FilesetResolver,
  PoseLandmarker,
} from "../vendor/tasks-vision/vision_bundle.mjs";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const chip = document.getElementById("chip");
const chipText = document.getElementById("chipText");
const cueEl = document.getElementById("cue");
const subEl = document.getElementById("sub");
const guide = document.getElementById("guide");
const calBtn = document.getElementById("calBtn");
const chk = { inFrame: document.getElementById("cFrame"), level: document.getElementById("cLevel"), centered: document.getElementById("cCenter") };

calBtn.addEventListener("click", () => {
  if (baseline) { calBtn.disabled = true; setTimeout(() => (calBtn.disabled = false), 3000); }
  calibrateRequest = true;
});

function setChecks(pos) {
  chk.inFrame.classList.toggle("on", !!pos.inFrame);
  chk.level.classList.toggle("on", !!pos.level);
  chk.centered.classList.toggle("on", !!pos.centered);
  guide.classList.toggle("ready", !!pos.ready);
  if (!baseline) calBtn.disabled = !pos.ready;
}

// MediaPipe BlazePose landmark indices.
const NOSE = 0, L_EYE = 2, R_EYE = 5, L_EAR = 7, R_EAR = 8, L_SH = 11, R_SH = 12;

let config = { badnessThreshold: 37 };
let paused = false;
let calibrateRequest = false;
let calibrating = null; // { samples: [], until }
let baseline = null; // median feature vector
let feat = null; // EMA-smoothed live features
let badState = false; // hysteresis state

// ---- helpers --------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 });

const FEAT_KEYS = ["sw", "eye", "shY", "headY", "neck", "noseDrop", "fwdZ", "noseZ", "shTilt", "headTilt"];

// Rich posture feature vector from one frame. Uses the depth (z) channel so we
// can catch leaning forward/back — which a flat 2D view misses entirely.
function featuresFrom(lm) {
  const ls = lm[L_SH], rs = lm[R_SH], le = lm[L_EAR], re = lm[R_EAR],
    nose = lm[NOSE], leye = lm[L_EYE], reye = lm[R_EYE];
  if (![ls, rs, le, re, nose].every((p) => (p.visibility ?? 1) > 0.5)) return null;
  const shMid = mid(ls, rs), earMid = mid(le, re);
  const sw = dist(ls, rs);
  if (sw < 1e-4) return null;
  const eye = dist(leye, reye) || sw * 0.3;
  return {
    sw,                              // shoulder width — distance/lean proxy
    eye,                             // inter-eye distance — head-only distance proxy
    shY: shMid.y,                    // shoulder height in frame (slump = lower)
    headY: earMid.y,                 // head height in frame
    neck: (shMid.y - earMid.y) / sw, // neck gap (head sinking)
    noseDrop: (nose.y - earMid.y) / sw, // looking down
    fwdZ: earMid.z - shMid.z,        // forward-head / recline (depth)
    noseZ: nose.z - shMid.z,         // head depth
    shTilt: (ls.y - rs.y) / sw,      // shoulder roll
    headTilt: (le.y - re.y) / sw,    // head roll
  };
}

function smoothFeatures(raw) {
  if (!feat) { feat = { ...raw }; return feat; }
  const a = 0.35; // EMA — calms jitter, keeps it responsive
  for (const k of FEAT_KEYS) feat[k] = feat[k] * (1 - a) + raw[k] * a;
  return feat;
}

function median(arr) {
  const s = [...arr].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
}

// Multi-factor posture badness (0..100) vs the calibrated baseline. Small
// deadzones absorb natural movement; sums so several mild faults still add up.
function badness(f) {
  if (!baseline) return 0;
  const b = baseline;
  // Generous deadzones so normal sitting + natural fidgeting stays at ~0 (green).
  const sink = Math.max(0, (b.neck - f.neck) / Math.max(0.05, b.neck) - 0.06); // head sinking
  const down = Math.max(0, f.noseDrop - b.noseDrop - 0.05);                     // looking down
  const distBad = Math.max(0, (Math.abs(f.sw / b.sw - 1) + Math.abs(f.eye / b.eye - 1)) / 2 - 0.08); // moved in/back
  const vDrop = Math.max(0, f.shY - b.shY - 0.03) + Math.max(0, f.headY - b.headY - 0.03);            // slumped down
  const zFwd = Math.max(0, b.fwdZ - f.fwdZ), zBack = Math.max(0, f.fwdZ - b.fwdZ);
  const zBad = Math.max(0, zFwd * 1.0 + zBack * 0.5 - 0.05);                    // forward head / recline
  const tilt = Math.max(0, Math.abs(f.shTilt - b.shTilt) + Math.abs(f.headTilt - b.headTilt) - 0.05);
  const raw =
    sink * 90 + down * 200 + distBad * 120 + vDrop * 240 + zBad * 150 + tilt * 100;
  return Math.min(100, raw);
}

// cls: 'good' | 'bad' | 'none'  ·  label = chip text  ·  hint = big cue line
function setState(cls, label, score, hint) {
  chip.className = cls === "bad" ? "bad" : cls === "good" ? "good" : "warn";
  chipText.textContent = label;
  if (hint !== undefined && hint !== null) cueEl.textContent = hint;
}

function drawSkeleton(lm) {
  ctx.save();
  ctx.scale(-1, 1); // mirror so it feels like a mirror
  ctx.translate(-canvas.width, 0);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  if (!lm) return;
  const pts = [NOSE, L_EAR, R_EAR, L_SH, R_SH];
  ctx.fillStyle = "#34c759";
  ctx.strokeStyle = "rgba(52,199,89,.7)";
  ctx.lineWidth = 2;
  const px = (p) => ({ x: (1 - p.x) * canvas.width, y: p.y * canvas.height }); // mirrored
  const line = (a, b) => {
    const A = px(lm[a]), B = px(lm[b]);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
  };
  line(L_SH, R_SH); line(L_EAR, R_EAR); line(NOSE, L_EAR); line(NOSE, R_EAR);
  for (const i of pts) {
    const p = px(lm[i]);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

// ---- main loop ------------------------------------------------------------
let landmarker = null;
let lastSent = 0;
let currentStream = null;
let videoTrack = null;
let cameraStarted = false;

// (Re)open the webcam using the configured device, at the widest field of view
// we can get — high resolution + minimum zoom (e.g. iPhone 0.5x ultra-wide).
async function startCamera() {
  setState("none", "switching camera…", null, "");
  if (currentStream) { currentStream.getTracks().forEach((t) => t.stop()); currentStream = null; }
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if (config.cameraId) v.deviceId = { exact: config.cameraId };
  else v.facingMode = "user";
  const stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
  currentStream = stream;
  videoTrack = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play();
  cameraStarted = true;
  await applyFov();
  reportCameras();
}

// Push the lens to its widest: minimum zoom = maximum field of view.
async function applyFov() {
  if (!videoTrack || !videoTrack.getCapabilities) return;
  try {
    const caps = videoTrack.getCapabilities();
    const adv = [];
    if (caps.zoom && typeof caps.zoom.min === "number") {
      let z;
      if (config.wideFov !== false) z = caps.zoom.min; // auto-widest
      else {
        const t = Math.min(1, Math.max(0, config.camZoom || 0));
        z = caps.zoom.min + t * (caps.zoom.max - caps.zoom.min); // manual
      }
      adv.push({ zoom: z });
    }
    if (caps.width && caps.width.max && caps.height && caps.height.max)
      adv.push({ width: caps.width.max, height: caps.height.max });
    if (adv.length) await videoTrack.applyConstraints({ advanced: adv });
  } catch (e) { console.warn("applyFov:", e.message); }
}

async function reportCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => ({ id: d.deviceId, label: d.label || "Camera" }));
    const active = videoTrack && videoTrack.getSettings ? videoTrack.getSettings().deviceId : "";
    const caps = videoTrack && videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    const zoomSupported = !!(caps && caps.zoom && typeof caps.zoom.min === "number");
    window.api.send("cameras:list", { cameras, active, zoomSupported });
  } catch (_) {}
}

async function init() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      new URL("../vendor/wasm", import.meta.url).href
    );
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: new URL("../models/pose_landmarker_full.task", import.meta.url).href,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    await startCamera();
    setState("none", "no person", null, "Calibrate from the menu while sitting upright.");
    window.api.send("monitor:ready");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    setState("none", "camera error", null, String(err.message || err));
    window.api.send("monitor:error", String(err.message || err));
  }
}

// Live positioning check used during calibration coaching.
function positioningFrom(lm) {
  const ls = lm[L_SH], rs = lm[R_SH], le = lm[L_EAR], re = lm[R_EAR], nose = lm[NOSE];
  const pts = [ls, rs, le, re, nose];
  const vis = pts.every((p) => (p.visibility ?? 1) > 0.5);
  const within = (p) => p.x > 0.04 && p.x < 0.96 && p.y > 0.04 && p.y < 0.96;
  const inFrame = vis && pts.every(within);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y) || 1;
  const level = Math.abs(ls.y - rs.y) / sw < 0.1;
  const midx = (ls.x + rs.x) / 2;
  const centered = midx > 0.34 && midx < 0.66;
  return { inFrame, level, centered, ready: inFrame && level && centered };
}

function loop() {
  requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2) return;

  const now = performance.now();
  let result;
  try {
    result = landmarker.detectForVideo(video, now);
  } catch (_) {
    return;
  }
  const lm = result.landmarks && result.landmarks[0];
  drawSkeleton(lm);

  if (paused) {
    setState("none", "paused", null, "Monitoring paused.");
    return;
  }

  const raw = lm ? featuresFrom(lm) : null;

  // calibration capture (median of raw samples = robust baseline)
  if (calibrateRequest && raw) {
    calibrateRequest = false;
    calibrating = { samples: [], until: Date.now() + 2500 };
  }
  if (calibrating && raw) {
    calibrating.samples.push(raw);
    setState("none", "calibrating…", null, "Hold still — sitting tall…");
    subEl.textContent = "Capturing your baseline";
    if (Date.now() >= calibrating.until && calibrating.samples.length >= 8) {
      const s = calibrating.samples;
      baseline = {};
      for (const k of FEAT_KEYS) baseline[k] = median(s.map((x) => x[k]));
      calibrating = null; feat = null; badState = false;
      document.body.classList.add("calibrated");
      calBtn.textContent = "Re-calibrate"; calBtn.disabled = false;
      setState("good", "calibrated", null, "Calibrated ✓");
      subEl.textContent = "I'll watch your posture from here";
      window.api.send("monitor:calibrated", baseline); // persisted by main
    }
    return;
  }

  if (!raw) {
    setState("none", "no person", null, baseline ? "Step into view" : "Sit in front of the camera");
    subEl.textContent = "";
    feat = null;
    throttleSend({ state: "no-person", score: 0 });
    return;
  }

  if (!baseline) {
    const pos = positioningFrom(lm);
    const cue = !pos.inFrame
      ? "Move so your head & shoulders fill the guide"
      : !pos.level
      ? "Level your shoulders"
      : !pos.centered
      ? "Center yourself in the frame"
      : "Looking good — sit tall, then Calibrate";
    setState(pos.ready ? "good" : "none", pos.ready ? "ready" : "position yourself", null, cue);
    subEl.textContent = pos.ready ? "Roll shoulders back · chin up · sit tall" : "Fill the dashed guide";
    setChecks(pos);
    throttleSend({ state: "uncalibrated", score: 0, pos });
    return;
  }

  const f = smoothFeatures(raw);
  const score = badness(f);
  // hysteresis: enter "bad" above the threshold, only leave below 60% of it —
  // keeps the state stable so nudges actually accumulate and fire.
  const T = config.badnessThreshold ?? 37;
  if (badState && score < T * 0.6) badState = false;
  else if (!badState && score > T) badState = true;

  const cue = badState ? cueFor(f) : null;
  const proximity = Math.max(0, Math.min(100, (f.sw / baseline.sw - 1) * 300));
  setState(badState ? "bad" : "good", badState ? "fix your posture" : "good posture", score,
    badState ? cue : "Nice — keep it up");
  subEl.textContent = badState ? "" : "";
  throttleSend({ state: badState ? "bad" : "good", score, proximity, cue });
}

// Pick the dominant fault so the on-screen cue is specific, not generic.
function cueFor(f) {
  const b = baseline;
  if (!b) return "Sit up tall.";
  const faults = [
    [Math.max(0, b.neck - f.neck) * 4, "Lift your head — your neck is collapsing"],
    [Math.max(0, f.noseDrop - b.noseDrop) * 6, "Raise your chin — you're looking down"],
    [Math.max(0, 1 - f.sw / b.sw) * 3, "Sit back up — you've slumped backward"],
    [Math.max(0, f.sw / b.sw - 1) * 3, "Ease back from the screen"],
    [Math.max(0, f.shY - b.shY) * 7, "Sit up — you've sunk down in the chair"],
    [Math.max(0, b.fwdZ - f.fwdZ) * 5, "Pull your head back over your shoulders"],
    [(Math.abs(f.shTilt - b.shTilt) + Math.abs(f.headTilt - b.headTilt)) * 3, "Level out — you're leaning to one side"],
  ];
  faults.sort((a, c) => c[0] - a[0]);
  return faults[0][1];
}

function throttleSend(payload) {
  const now = Date.now();
  if (now - lastSent < 500) return; // ~2 updates/sec is plenty
  lastSent = now;
  window.api.send("posture:update", payload);
}

// ---- IPC from main --------------------------------------------------------
window.api.on("monitor:config", (cfg) => {
  const prevCam = config.cameraId || "", prevWide = config.wideFov, prevZoom = config.camZoom;
  config = { ...config, ...cfg };
  if (cameraStarted) {
    if ((config.cameraId || "") !== prevCam)
      startCamera().catch((e) => window.api.send("monitor:error", String(e.message || e)));
    else if (config.wideFov !== prevWide || config.camZoom !== prevZoom) applyFov();
  }
});
window.api.on("monitor:setPaused", (p) => {
  paused = !!p;
});
window.api.on("monitor:calibrate", () => {
  calibrateRequest = true;
});
// restore a saved baseline from a previous session
window.api.on("monitor:baseline", (b) => {
  if (!b || baseline) return;
  baseline = b;
  feat = null;
  badState = false;
  document.body.classList.add("calibrated");
  calBtn.textContent = "Re-calibrate";
  calBtn.disabled = false;
});

// ---- sound / voice (this hidden window is our audio sink) -----------------
let actx = null;
function chime(kind, volume) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const now = actx.currentTime;
    const seq =
      kind === "break-start" ? [523, 659, 784] :
      kind === "break-end" ? [784, 523] :
      kind === "nudge" ? [440, 392] : [660];
    seq.forEach((f, i) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = now + i * 0.16;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime((volume ?? 0.6) * 0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g).connect(actx.destination);
      o.start(t);
      o.stop(t + 0.2);
    });
  } catch (_) {}
}
function speak(text, volume) {
  try {
    const u = new SpeechSynthesisUtterance(text || "Check your posture.");
    u.volume = volume ?? 0.7;
    u.rate = 1;
    speechSynthesis.speak(u);
  } catch (_) {}
}
window.api.on("sound:play", ({ type, text, volume }) => {
  if (type === "voice") speak(text, volume);
  else chime(type, volume);
});

init();
