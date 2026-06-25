import {
  FilesetResolver,
  PoseLandmarker,
} from "../vendor/tasks-vision/vision_bundle.mjs";

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const bodyEl = document.body;
const stateEl = document.getElementById("state");
const scoreEl = document.getElementById("score");
const msgEl = document.getElementById("msg");
const fillEl = document.getElementById("fill");

// MediaPipe BlazePose landmark indices we care about.
const NOSE = 0;
const L_EAR = 7,
  R_EAR = 8;
const L_SH = 11,
  R_SH = 12;

let config = { badnessThreshold: 35, weights: { neck: 1, lean: 0.6, tilt: 0.8 } };
let paused = false;
let calibrateRequest = false;
let calibrating = null; // { samples: [], until: timestamp }
let baseline = null; // { neckRatio, shoulderWidth, noseDrop }

// ---- helpers --------------------------------------------------------------
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function metricsFrom(lm) {
  const ls = lm[L_SH],
    rs = lm[R_SH],
    le = lm[L_EAR],
    re = lm[R_EAR],
    nose = lm[NOSE];
  // visibility gate
  const vis = [ls, rs, le, re, nose].every((p) => (p.visibility ?? 1) > 0.5);
  if (!vis) return null;

  const shoulderMid = mid(ls, rs);
  const earMid = mid(le, re);
  const shoulderWidth = dist(ls, rs); // grows as you lean toward the camera
  if (shoulderWidth < 1e-4) return null;

  // Vertical gap from shoulders up to ears, normalized by shoulder width.
  // Shrinks when the head sinks / neck compresses (slouch).
  const neckRatio = (shoulderMid.y - earMid.y) / shoulderWidth;
  // How far the nose sits below the ear line (looking down), normalized.
  const noseDrop = (nose.y - earMid.y) / shoulderWidth;

  return { neckRatio, shoulderWidth, noseDrop };
}

// Combine deviations from the calibrated baseline into a 0..100 "badness".
function badness(m) {
  if (!baseline) return 0;
  const w = config.weights || { neck: 1, lean: 0.6, tilt: 0.8 };
  // head sinking: neckRatio dropped relative to baseline
  const dNeck = Math.max(0, (baseline.neckRatio - m.neckRatio) / baseline.neckRatio);
  // leaning toward the camera: shoulders appear wider than baseline
  const dLean = Math.max(0, m.shoulderWidth / baseline.shoulderWidth - 1);
  // looking down: nose dropped further below the ears than baseline
  const dTilt = Math.max(0, m.noseDrop - baseline.noseDrop);

  const raw = dNeck * w.neck + dLean * 1.5 * w.lean + dTilt * 2.0 * w.tilt;
  return Math.min(100, raw * 130);
}

function setState(cls, label, score, hint) {
  bodyEl.className = cls;
  stateEl.textContent = label;
  scoreEl.textContent = score == null ? "" : `score ${Math.round(score)}`;
  if (hint !== undefined) msgEl.textContent = hint;
  if (score != null) {
    const pct = Math.min(100, score);
    fillEl.style.width = pct + "%";
    fillEl.style.background = cls === "bad" ? "#ffcc00" : cls === "good" ? "#34c759" : "#666";
  }
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

async function init() {
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      new URL("../vendor/wasm", import.meta.url).href
    );
    landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: new URL(
          "../models/pose_landmarker_lite.task",
          import.meta.url
        ).href,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setState("none", "no person", null, "Calibrate from the menu while sitting upright.");
    window.api.send("monitor:ready");
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    setState("none", "camera error", null, String(err.message || err));
    window.api.send("monitor:error", String(err.message || err));
  }
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

  const m = lm ? metricsFrom(lm) : null;

  // calibration capture
  if (calibrateRequest && m) {
    calibrateRequest = false;
    calibrating = { samples: [], until: Date.now() + 2000 };
  }
  if (calibrating && m) {
    calibrating.samples.push(m);
    setState("none", "calibrating…", null, "Hold still, sitting tall…");
    if (Date.now() >= calibrating.until && calibrating.samples.length >= 5) {
      const s = calibrating.samples;
      const avg = (key) => s.reduce((a, x) => a + x[key], 0) / s.length;
      baseline = {
        neckRatio: avg("neckRatio"),
        shoulderWidth: avg("shoulderWidth"),
        noseDrop: avg("noseDrop"),
      };
      calibrating = null;
      window.api.send("monitor:calibrated", true);
    }
    return;
  }

  if (!m) {
    setState("none", "no person", null,
      baseline ? "" : "Calibrate from the menu while sitting upright.");
    throttleSend({ state: "no-person", score: 0 });
    return;
  }

  if (!baseline) {
    setState("none", "not calibrated", null,
      "Choose “Calibrate posture” from the menu while sitting tall.");
    throttleSend({ state: "uncalibrated", score: 0 }); // lets the setup wizard show presence
    return;
  }

  const score = badness(m);
  const bad = score > (config.badnessThreshold ?? 35);
  // proximity: how much closer to the camera than baseline (leaning in)
  const proximity = baseline
    ? Math.max(0, Math.min(100, (m.shoulderWidth / baseline.shoulderWidth - 1) * 300))
    : 0;
  setState(bad ? "bad" : "good", bad ? "slouching" : "good posture", score,
    bad ? "Lift your head, roll shoulders back." : "Nice — keep it up.");
  throttleSend({ state: bad ? "bad" : "good", score, proximity });
}

function throttleSend(payload) {
  const now = Date.now();
  if (now - lastSent < 500) return; // ~2 updates/sec is plenty
  lastSent = now;
  window.api.send("posture:update", payload);
}

// ---- IPC from main --------------------------------------------------------
window.api.on("monitor:config", (cfg) => {
  config = { ...config, ...cfg };
});
window.api.on("monitor:setPaused", (p) => {
  paused = !!p;
});
window.api.on("monitor:calibrate", () => {
  calibrateRequest = true;
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
