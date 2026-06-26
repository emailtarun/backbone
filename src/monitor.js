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
// Weights are tuned per camera position stored in the baseline.
function badness(f) {
  if (!baseline) return 0;
  const b = baseline;

  const sink = Math.max(0, (b.neck - f.neck) / Math.max(0.05, b.neck) - 0.05); // head sinking
  const down = Math.max(0, f.noseDrop - b.noseDrop - 0.04);                     // looking down
  const distBad = Math.max(0, (Math.abs(f.sw / b.sw - 1) + Math.abs(f.eye / b.eye - 1)) / 2 - 0.05); // leaned in/back
  const vDrop = Math.max(0, f.shY - b.shY - 0.025) + Math.max(0, f.headY - b.headY - 0.025);
  const zFwd = Math.max(0, b.fwdZ - f.fwdZ), zBack = Math.max(0, f.fwdZ - b.fwdZ);
  const zBad = Math.max(0, zFwd * 1.0 + zBack * 0.6 - 0.04);

  // Tilt: off-centre cameras introduce lateral perspective so one shoulder always
  // appears lower. The baseline absorbs this bias, but residual noise is higher —
  // halve the tilt weight to avoid false positives.
  const tiltW = b.cameraOffCentre ? 55 : 110;
  const tilt = Math.max(0, Math.abs(f.shTilt - b.shTilt) + Math.abs(f.headTilt - b.headTilt) - 0.045);

  // From a below-eye camera, slumping down is very visible (large vDrop signal)
  // but noseDrop is harder to read — reduce its contribution slightly.
  const downW = b.cameraBelow ? 160 : 220;

  const raw =
    sink * 100 + down * downW + distBad * 175 + vDrop * 280 + zBad * 185 + tilt * tiltW;
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
let lastDetect = 0;
let currentStream = null;
let videoTrack = null;
let cameraStarted = false;
let noFrameWatch = null; // watchdog: detect a stream with no actual frames
let camGen = 0; // increments per startCamera() call; guards against overlapping starts

// (Re)open the webcam using the configured device, at the widest field of view
// we can get — high resolution + minimum zoom (e.g. iPhone 0.5x ultra-wide).
async function startCamera() {
  const gen = ++camGen; // re-entrancy guard: a newer call supersedes this one
  setState("none", "switching camera…", null, "");
  if (currentStream) { currentStream.getTracks().forEach((t) => t.stop()); currentStream = null; }
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if (config.cameraId) {
    v.deviceId = { exact: config.cameraId }; // explicit choice (e.g. iPhone) is honored
  } else {
    // No explicit choice: prefer a real built-in webcam. iPhone/Continuity
    // defaults hang when the phone's away; IR/virtual cams give black frames.
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      const real = cams.filter((d) => !/\b(ir|infrared|virtual|obs)\b/i.test(d.label));
      const pool = real.length ? real : cams;
      const builtin = pool.find((d) => /facetime|built-?in|macbook|imac|integrated|webcam/i.test(d.label)) || pool[0];
      if (builtin && builtin.deviceId) v.deviceId = { exact: builtin.deviceId };
      else v.facingMode = "user";
    } catch (_) { v.facingMode = "user"; }
  }
  // Timeout so an unresponsive camera surfaces an error instead of hanging forever.
  const stream = await Promise.race([
    navigator.mediaDevices.getUserMedia({ video: v, audio: false }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Camera didn't respond — pick a different camera in Settings.")), 8000)),
  ]);
  if (gen !== camGen) { stream.getTracks().forEach((t) => t.stop()); return; } // superseded — drop this stream
  currentStream = stream;
  videoTrack = stream.getVideoTracks()[0];
  video.srcObject = stream;
  video.muted = true;
  // Do NOT await play(): on a hidden <video> Chromium can leave the play()
  // promise pending forever. Frames still flow; the loop waits on readyState.
  video.play().catch(() => {});
  cameraStarted = true;
  await applyFov();
  reportCameras();
  // If no frames arrive (camera temporarily contended), quietly retry — it
  // self-heals as soon as the camera is free. No warning, no manual relaunch.
  clearTimeout(noFrameWatch);
  noFrameWatch = setTimeout(() => {
    if (video.readyState < 2) {
      setState("none", "connecting camera…", null, "");
      startCamera().catch(() => {});
    }
  }, 4000);
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

async function makeLandmarker(fileset, delegate) {
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: new URL("../models/pose_landmarker_full.task", import.meta.url).href,
      delegate,
    },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}

async function init() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      new URL("../vendor/wasm", import.meta.url).href
    );
    // GPU is fast but its WebGL context fails on some machines (Windows iGPUs,
    // VMs, RDP). Fall back to CPU so posture monitoring still works everywhere.
    try {
      landmarker = await makeLandmarker(fileset, "GPU");
    } catch (gpuErr) {
      console.warn("[pose] GPU delegate failed, falling back to CPU:", gpuErr && gpuErr.message);
      landmarker = await makeLandmarker(fileset, "CPU");
    }
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
// Thresholds are deliberately loose so off-centre and desk-height cameras
// can still calibrate — the baseline absorbs the geometric bias.
function positioningFrom(lm) {
  const ls = lm[L_SH], rs = lm[R_SH], le = lm[L_EAR], re = lm[R_EAR], nose = lm[NOSE];
  const pts = [ls, rs, le, re, nose];
  const vis = pts.every((p) => (p.visibility ?? 1) > 0.5);
  const within = (p) => p.x > 0.04 && p.x < 0.96 && p.y > 0.04 && p.y < 0.96;
  const inFrame = vis && pts.every(within);
  const sw = Math.hypot(ls.x - rs.x, ls.y - rs.y) || 1;
  const midx = (ls.x + rs.x) / 2;
  // Wide threshold: off-centre cameras make shoulders appear tilted by perspective
  const level = Math.abs(ls.y - rs.y) / sw < 0.28;
  // Wide range: laptop to the left or right of the monitor is totally fine
  const centered = midx > 0.12 && midx < 0.88;
  // Camera-position hints (informational, stored in baseline)
  const earMidY = (le.y + re.y) / 2;
  const cameraBelow = nose.y < earMidY;        // nose appears above ears → camera looks up
  const cameraOffCentre = Math.abs(midx - 0.5) > 0.16;
  return { inFrame, level, centered, ready: inFrame && level && centered,
           cameraBelow, cameraOffCentre, midx };
}

function loop() {
  requestAnimationFrame(loop);
  if (!landmarker || video.readyState < 2) return;
  if (noFrameWatch) { clearTimeout(noFrameWatch); noFrameWatch = null; console.log("[cam] live"); } // frames flowing

  // Throttle the heavy pose model to ~12 fps — posture changes slowly, and this
  // cuts CPU/GPU load ~5x (keeps weaker Macs cool and responsive).
  const now = performance.now();
  if (now - lastDetect < 80) return;
  lastDetect = now;
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
    calibrating = { samples: [], camSamples: [], until: Date.now() + 2500 };
  }
  if (calibrating && raw) {
    calibrating.samples.push(raw);
    // Track raw landmark positions to detect camera geometry
    calibrating.camSamples.push({
      noseY: lm[NOSE].y,
      earMidY: (lm[L_EAR].y + lm[R_EAR].y) / 2,
      midx: (lm[L_SH].x + lm[R_SH].x) / 2,
      shTiltAbs: Math.abs(lm[L_SH].y - lm[R_SH].y) /
                 (Math.hypot(lm[L_SH].x - lm[R_SH].x, lm[L_SH].y - lm[R_SH].y) || 1),
    });
    setState("none", "calibrating…", null, "Hold still — sitting tall…");
    subEl.textContent = "Capturing your baseline";
    if (Date.now() >= calibrating.until && calibrating.samples.length >= 8) {
      const s = calibrating.samples;
      baseline = {};
      for (const k of FEAT_KEYS) baseline[k] = median(s.map((x) => x[k]));
      // Store camera-position metadata so scoring can compensate
      const cs = calibrating.camSamples;
      const medNoseY  = median(cs.map((c) => c.noseY));
      const medEarY   = median(cs.map((c) => c.earMidY));
      const medMidx   = median(cs.map((c) => c.midx));
      const medShTilt = median(cs.map((c) => c.shTiltAbs));
      baseline.cameraBelow     = medNoseY < medEarY;          // camera looks up at user
      baseline.cameraOffCentre = Math.abs(medMidx - 0.5) > 0.16; // laptop to one side
      baseline.cameraShTilt    = medShTilt;                   // perspective tilt at calibration
      calibrating = null; feat = null; badState = false;
      document.body.classList.add("calibrated");
      calBtn.textContent = "Re-calibrate"; calBtn.disabled = false;
      setState("good", "done", null, "Calibration complete ✓");
      subEl.textContent =
        (baseline.cameraBelow ? "Low camera detected · " : baseline.cameraOffCentre ? "Side camera detected · " : "") +
        "closing camera…";
      window.api.send("monitor:calibrated", baseline); // persisted by main; main closes the window
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
      ? "Even your shoulders up — or reposition your camera if it's very far to one side"
      : !pos.centered
      ? "Move a little more in front of your camera"
      : pos.cameraBelow
      ? "Camera is below eye level — sit tall, look straight ahead, then Calibrate"
      : pos.cameraOffCentre
      ? "Camera is off to one side — that's fine, face your screen normally, then Calibrate"
      : "Looking good — sit tall, then Calibrate";
    const sub = !pos.ready
      ? "Fill the dashed guide"
      : pos.cameraBelow
      ? "Low camera detected — works great, just calibrate upright"
      : pos.cameraOffCentre
      ? "Side camera detected — works great, just sit facing your screen"
      : "Roll shoulders back · chin up · sit tall";
    setState(pos.ready ? "good" : "none", pos.ready ? "ready" : "position yourself", null, cue);
    subEl.textContent = sub;
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
  // proximity = how much you've leaned IN, from both shoulder-width and face
  // distance (steadier than shoulders alone); lower gain = less twitchy.
  const leanIn = ((f.sw / baseline.sw - 1) + (f.eye / baseline.eye - 1)) / 2;
  const proximity = Math.max(0, Math.min(100, leanIn * 250));
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
