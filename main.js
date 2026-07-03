const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain,
  nativeImage, systemPreferences, powerMonitor, globalShortcut, screen,
} = require("electron");
const { session } = require("electron");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");

// In-progress dev build (npm start): use a separate name + data folder so it
// never touches the installed app's settings/calibration. MUST run before any
// Store is created (i.e. before requiring ./lib/stats below).
const IS_DEV = !app.isPackaged;
if (IS_DEV) {
  try {
    app.setName("Backbone (Dev)");
    app.setPath("userData", path.join(app.getPath("appData"), "Backbone (Dev)"));
  } catch (_) {}
}

const stats = require("./lib/stats");
const sched = require("./lib/schedule");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// Built-in stretch library. mode: "time" (seconds) · "side" (perSideSec, switch
// at midpoint) · "reps" (repsPerSide, ~ secsPerRep each side). `anim` selects an
// animated demonstration in the overlay; `area` drives posture-targeted picks.
const STRETCH_LIBRARY = [
  { id: "neck-rolls", name: "Neck rolls", area: "neck", anim: "neckroll", mode: "time", seconds: 30,
    cue: "Drop your chin and roll your head in slow, easy circles - one way, then the other." },
  { id: "trap-stretch", name: "Trap stretch", area: "side", anim: "traptilt", mode: "side", perSideSec: 30,
    cue: "Ear toward shoulder, let the hand rest on your head for a gentle pull down the side of your neck." },
  { id: "chin-tucks", name: "Chin tucks", area: "neck", anim: "chintuck", mode: "time", seconds: 30,
    cue: "Glide your chin straight back to make a “double chin”, hold a beat, release. Repeat slowly." },
  { id: "shoulder-rolls", name: "Shoulder rolls", area: "shoulders", anim: "shoulderroll", mode: "time", seconds: 30,
    cue: "Lift your shoulders to your ears, then roll them back and down in big slow circles." },
  { id: "bow-and-arrow", name: "Bow and arrow", area: "shoulders", anim: "bowarrow", mode: "reps", repsPerSide: 5,
    cue: "One arm reaches forward, the other draws back like pulling a bowstring - open the chest as you pull." },
  { id: "open-book", name: "Open book", area: "upperback", anim: "openbook", mode: "time", seconds: 45,
    cue: "Arms out front, palms together. Sweep the top arm open like a book and follow it with your eyes. Alternate sides." },
  { id: "desk-angels", name: "Desk angels", area: "upperback", anim: "deskangel", mode: "time", seconds: 40,
    cue: "Sit tall. Make a goal-post “W” with your arms, backs of the hands toward the wall behind you. Slowly slide them up to a “Y” and back down, squeezing your shoulder blades the whole time." },
  { id: "spinal-twist", name: "Seated spinal twist", area: "upperback", anim: "twist", mode: "side", perSideSec: 20,
    cue: "Hand to the opposite knee and twist gently from the waist. Lengthen up as you turn." },
  { id: "chest-opener", name: "Chest opener", area: "chest", anim: "chestopen", mode: "time", seconds: 30,
    cue: "Clasp your hands behind your back, lift them slightly and squeeze your shoulder blades together." },
  { id: "overhead-reach", name: "Overhead reach", area: "fullbody", anim: "reachup", mode: "time", seconds: 30,
    cue: "Interlace your fingers and press your palms to the ceiling - lengthen your whole spine." },
  { id: "stand-fold", name: "Stand & fold", area: "fullbody", anim: "standfold", mode: "time", seconds: 30,
    cue: "Stand and reach tall overhead, then slowly fold forward and let your head and arms hang." },
  { id: "wrist-stretch", name: "Wrist & finger stretch", area: "wrists", anim: "wrist", mode: "side", perSideSec: 15,
    cue: "Extend one arm, fingers up then down, and gently draw them back with your other hand." },
  { id: "wrist-circles", name: "Wrist circles", area: "wrists", anim: "wrist", mode: "time", seconds: 30,
    cue: "Lift your hands off the desk and roll both wrists in slow circles - one way, then the other. Let the fingers stay loose." },
  { id: "finger-fan", name: "Finger fans", area: "wrists", anim: "wrist", mode: "time", seconds: 20,
    cue: "Spread your fingers wide like a fan, hold a beat, then make a loose fist. Repeat slowly - great after heavy typing." },
  { id: "box-breathing", name: "Box breathing", area: "mind", anim: "breath", mode: "breath", seconds: 64,
    cue: "Follow the ring: breathe in for 4, hold 4, out 4, hold 4. Shoulders soft, breathe into your belly." },
];

const SECS_PER_REP = 4;
function stretchTotal(s) {
  if (s.mode === "side") return (s.perSideSec || 20) * 2;
  if (s.mode === "reps") return (s.repsPerSide || 5) * SECS_PER_REP * 2;
  return s.seconds || 30;
}

// Map a posture cue to the body area its stretches should target.
function cueArea(cue) {
  if (!cue) return null;
  const c = cue.toLowerCase();
  if (c.includes("one side") || c.includes("level")) return "side";
  if (c.includes("head back over") || c.includes("screen")) return "chest";
  if (c.includes("slump") || c.includes("sunk")) return "upperback";
  if (c.includes("neck") || c.includes("chin") || c.includes("looking down")) return "neck";
  return "upperback";
}

// Build a long-break routine: weight by the slouches you actually do, rotate so
// you don't repeat last time's set, and fill to roughly the configured duration.
function buildRoutine(kind) {
  if (kind === "micro") {
    const secs = store.get("microDurationSec") || 60;
    return [{ id: "eye-rest", name: "Eye break", area: "eyes", anim: "eyes", mode: "time",
      seconds: secs, total: secs,
      cue: "Look at something across the room or out a window (20+ feet away) and blink slowly. Let your eyes fully relax until the timer is done." }];
  }
  if (kind === "stand") {
    const mins = store.get("standMinutes") || 5;
    return [{ id: "stand-up", name: "Stand up", area: "fullbody", anim: "standfold", mode: "time",
      seconds: 30, total: 30,
      cue: `Get on your feet and stay up for ~${mins} minute${mins === 1 ? "" : "s"} - stretch, grab water, or keep working standing.` }];
  }
  if (kind === "breath") {
    const s = STRETCH_LIBRARY.find((x) => x.id === "box-breathing");
    return [{ ...s, total: stretchTotal(s) }];
  }
  const disabled = store.get("disabledStretches") || [];
  const enabled = STRETCH_LIBRARY.filter((s) => !disabled.includes(s.id));
  const stored = store.get("faultTally") || {};
  const tally = { ...stored };
  // With no posture-fault history yet, nudge wrist work forward - keyboard strain
  // doesn't show on the webcam, and hourly wrist relief is the evidence-backed dose.
  if (!Object.keys(tally).length) tally.wrists = 1;
  const last = new Set(store.get("lastRoutineIds") || []);
  const scored = enabled
    .map((s) => {
      let key = Math.random() / (1 + (tally[s.area] || 0) * 1.5); // higher fault area => earlier
      if (last.has(s.id)) key += 1; // push recently-used to the back
      return { s, key };
    })
    .sort((a, b) => a.key - b.key);

  const target = store.get("longDurationSec") || 180;
  const out = [];
  let t = 0;
  for (const { s } of scored) {
    out.push(s);
    t += stretchTotal(s);
    if (out.length >= 3 && t >= target) break;
    if (out.length >= 6) break;
  }
  store.set("lastRoutineIds", out.map((s) => s.id));
  // gentle decay so the targeting keeps adapting (decay the stored tally, not the
  // scoring copy - the wrist fallback above must not leak into persistence)
  const decayed = {};
  for (const k of Object.keys(stored)) decayed[k] = stored[k] * 0.8;
  store.set("faultTally", decayed);
  return out.map((s) => ({ ...s, total: stretchTotal(s) }));
}

const store = new Store({
  defaults: {
    // posture
    postureEnabled: true,
    sensitivity: 50,
    holdSeconds: 20,
    alertCooldownMin: 3,
    nudgeStyle: "notification", // notification | flash | voice | silent
    proximityAlert: true,
    proximitySensitivity: 50,
    weights: { neck: 1.0, lean: 0.6, tilt: 0.8 },
    postureVarietyEnabled: true, // nudge when frozen in one position too long (dynamic posture)
    varietyMin: 30, // minutes of stillness before the posture-variety nudge
    // breaks
    microEnabled: true,
    microIntervalMin: 20,
    microDurationSec: 60, // evidence: 20-second eye breaks are too short - 1-2 min works
    longEnabled: true,
    longIntervalMin: 50,
    longDurationSec: 180,
    preBreakWarnSec: 10,
    preBreakStyle: "pill", // pill | dim (gradually tint the screen as the break approaches)
    strictBreaks: false,
    showCursorTimer: true,
    // sit / stand (opt-in - evidence: stand ~5 min every hour; alternate on a sit-stand desk)
    standEnabled: false,
    standIntervalMin: 60,
    standMinutes: 5, // the stand goal communicated in the prompt
    standStyle: "prompt", // prompt (notification) | overlay (30s break card)
    standMode: "remind", // remind (stand up briefly) | alternate (sit-stand desk: switch positions)
    altSitMin: 45, // alternate mode: minutes seated before the "stand up" cue
    altStandMin: 15, // alternate mode: minutes standing before the "sit down" cue
    // hydration (honest: no strong evidence - purely optional)
    hydrationEnabled: false,
    hydrationIntervalMin: 60,
    // sound
    soundEnabled: true,
    soundVolume: 0.6,
    // schedule
    workingHoursEnabled: false,
    workStart: "09:00",
    workEnd: "17:00",
    workDays: [1, 2, 3, 4, 5],
    quietHoursEnabled: false,
    quietStart: "22:00",
    quietEnd: "08:00",
    idlePauseSec: 60,
    idleResetBreaks: true,
    // apple watch / phone push (ntfy)
    watchEnabled: false,
    watchServer: "https://ntfy.sh",
    watchTopic: "",
    watchPosture: true,
    watchSlouchSec: 60, // buzz the watch after this many seconds of continuous slouching
    watchBreaks: false,
    watchPriority: 4, // ntfy priority: 2 low · 3 normal · 4 strong · 5 urgent
    // system / appearance
    launchAtLogin: false,
    startMonitoringOnLaunch: true,
    bugReports: true, // send anonymous crash/error reports (no video, no PII)
    installId: "", // random anonymous id to group a user's reports
    setupComplete: false,
    baseline: null, // persisted posture calibration (survives restarts)
    cameraId: "", // "" = system default camera
    wideFov: true, // widest field of view (min zoom) for best framing
    camZoom: 0, // manual zoom 0..1 (0 = widest); used when wideFov is off
    theme: "auto",
    overlayTheme: "slate",
    breakVoice: true, // spoken guidance during stretch breaks
    disabledStretches: [], // ids excluded from the rotation
    faultTally: {}, // posture-fault counts by area (for targeted routines)
    lastRoutineIds: [], // last routine, to avoid repeats
  },
});

// ---------------------------------------------------------------------------
// Crash / error reporting via Sentry (private dashboard). The DSN is a
// write-only client key - safe to ship. No video, no PII: IP/username/hostname
// are dropped and home-folder paths are scrubbed from stack traces. Opt-out via
// Settings → "Send anonymous bug reports".
// ---------------------------------------------------------------------------
const Sentry = require("@sentry/electron/main");
const SENTRY_DSN = "https://bee86425bdfb4b4a81bece6c61abdedd@o4511629059751936.ingest.de.sentry.io/4511629068861520";
let sentryOn = false;

function scrubEvent(event) {
  try {
    delete event.server_name; // hostname can identify the machine
    if (event.user) event.user = { id: event.user.id }; // keep only our anon id
    const re = /([\/\\](?:Users|home)[\/\\])[^\/\\]+/g;
    const clean = (s) => (typeof s === "string" ? s.replace(re, "$1<user>") : s);
    if (event.message) event.message = clean(event.message);
    for (const ex of (event.exception && event.exception.values) || []) {
      ex.value = clean(ex.value);
      for (const fr of (ex.stacktrace && ex.stacktrace.frames) || []) {
        fr.filename = clean(fr.filename);
        fr.abs_path = clean(fr.abs_path);
      }
    }
  } catch (_) {}
  return event;
}

function initSentry(force) {
  if (sentryOn) return true;
  if (!force && !store.get("bugReports")) return false;
  if (!store.get("installId")) { try { store.set("installId", crypto.randomUUID()); } catch (_) {} }
  Sentry.init({
    dsn: SENTRY_DSN,
    release: "backbone@" + app.getVersion(),
    environment: IS_DEV ? "dev" : "production",
    sendDefaultPii: false,
    autoSessionTracking: true, // release health: anonymous user/session counts per version
    // We handle uncaught errors ourselves (report but keep the app running),
    // so drop Sentry's own handlers that would exit the process.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection"),
    beforeSend: scrubEvent,
  });
  Sentry.setUser({ id: store.get("installId") || undefined });
  sentryOn = true;
  return true;
}
initSentry();

// Report but don't crash - better UX for a background app than hard-exiting.
process.on("uncaughtException", (e) => { if (sentryOn) Sentry.captureException(e); });
process.on("unhandledRejection", (e) => {
  if (!sentryOn) return;
  Sentry.captureException(e instanceof Error ? e : new Error("Unhandled rejection: " + String(e)));
});

function badnessThreshold() {
  // Balanced default (50 -> 40); higher sensitivity lowers it (stricter).
  return 65 - (store.get("sensitivity") / 100) * 50;
}
function proximityThreshold() {
  // Balanced default (50 -> ~44): triggers on a clear lean-in, ignores small shifts.
  return 68 - (store.get("proximitySensitivity") / 100) * 48;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tray = null;
const wins = {}; // monitor, overlay, flash, timer, dashboard, settings
let monitoring = false;
let postureState = "init";
let lastScore = 0;
let badSince = null;
let lastAlertAt = 0;
let lastWatchSlouchAt = 0; // last sustained-slouch watch buzz (per continuous-bad episode)
let lastEscalateSound = 0; // last escalation reminder beep (after 30s of slouching)

let clockedOut = false;
let clockedOutDay = null;
let isIdle = false;
let idleStartedAt = 0; // when the current idle stretch began (to reset breaks only on a real walk-away)
let breakActive = false;
let breakWatchdog = null; // force-ends a break if the overlay never reports done
let snoozeUntil = 0;

let microRemaining = 0; // seconds
let longRemaining = 0;
let standRemaining = 0; // seconds until the next stand/move prompt (when standEnabled)
let hydrationRemaining = 0;
let standPhase = "sit"; // sit-stand desk alternation state (standMode "alternate")
let altAwaiting = null; // "stand" | "sit" - cue sent, waiting for the user to confirm the switch
let standPromptedAt = 0; // when the last stand prompt fired (for presence-aware credit)
let awaySince = 0; // start of the current no-person stretch (stand credit + longest-sit)
let presentSince = 0; // start of the current continuous-presence stretch
let stillSince = 0; // last significant body movement (posture-variety nudge)
let warnShownFor = null; // 'micro' | 'long' | null
let preBreakEscOn = false; // Esc grabbed globally only while the pre-break pill shows

let updateReady = false; // a downloaded update is waiting to install
let updateVersion = "";
let checkingUpdate = false;
let lastTallyAt = 0; // throttle posture-fault tallying
let proximityOn = false; // "lean back" hysteresis state (owned by onPostureUpdate)
let glowOn = false, cueOn = false, proxShown = false, dimOn = false; // overlay element visibility (owned by flashCmd)
let flashShown = false; // is the transparent overlay window currently visible?
let flashHideTimer = null; // deferred hide so posture oscillation can't strobe the window
const lastFlash = {}; // last cmd signature per type, to skip redundant per-frame sends

// ---------------------------------------------------------------------------
// Tray icon
// ---------------------------------------------------------------------------
// Backbone spine glyph (5 vertebrae, gentle S-curve), shared by the macOS
// template icon and the Windows/Linux colored status icon.
function drawSpine(size, plot) {
  const s = size / 16;
  const cx = 8 * s, w = 10 * s, h = 2.1 * s, rr = h / 2;
  const rows = [
    { yc: 2.6, off: 0.6 }, { yc: 5.5, off: -0.3 }, { yc: 8.3, off: -0.8 },
    { yc: 11.1, off: -0.3 }, { yc: 13.9, off: 0.7 },
  ];
  for (const r of rows) {
    const bx = cx + r.off * s - w / 2, by = r.yc * s - h / 2;
    for (let y = Math.floor(by - 1); y <= Math.ceil(by + h + 1); y++)
      for (let x = Math.floor(bx - 1); x <= Math.ceil(bx + w + 1); x++) {
        const qx = Math.abs(x + 0.5 - (bx + w / 2)) - (w / 2 - rr);
        const qy = Math.abs(y + 0.5 - (by + h / 2)) - (h / 2 - rr);
        const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
        if (sd < 0.5) plot(x, y, Math.min(1, Math.max(0, 0.5 - sd)));
      }
  }
}
function makeTrayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4, 0);
  drawSpine(size, (x, y, cov) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i + 3] = Math.max(buf[i + 3], Math.round(cov * 255)); // black + alpha -> template
  });
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  img.setTemplateImage(true);
  return img;
}

const EMOJI = { good: "🟢", bad: "🟡", "no-person": "⚪️", paused: "⏸", init: "…" };
const MOD = process.platform === "darwin" ? "⌥⌘" : "Ctrl+Alt+";

// Minimal RGBA->PNG encoder so colored tray icons render correctly on every
// platform (createFromBitmap channel order is platform-dependent; PNG isn't).
function pngFromRGBA(width, height, rgba) {
  const crc32 = (buf) => {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const STATUS_COLORS = {
  good: [52, 199, 89], bad: [255, 204, 0], "no-person": [150, 150, 150],
  paused: [142, 142, 147], init: [142, 142, 147], clocked: [110, 132, 255], off: [120, 120, 128],
};
function makeStatusIcon(key) {
  const [r, g, b] = STATUS_COLORS[key] || STATUS_COLORS.off;
  const size = 16, rgba = Buffer.alloc(size * size * 4, 0);
  drawSpine(size, (x, y, cov) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
    rgba[i + 3] = Math.max(rgba[i + 3], Math.round(cov * 255));
  });
  return nativeImage.createFromBuffer(pngFromRGBA(size, size, rgba));
}

function fmtMin(sec) {
  const m = Math.round(sec / 60);
  return m <= 0 ? "<1 min" : `${m} min`;
}

// macOS-reliable approach: keep a context menu set (so clicks open it natively
// and it stays open), but only RE-SET it when something other than the volatile
// posture state changes - so a good/bad flicker as the user reaches to click can
// never rebuild the menu out from under them (which made it "disappear").
let lastMenuKey = null;
let lastTrayKey = null;
function menuKey() {
  let nb = "off";
  if ((store.get("microEnabled") || store.get("longEnabled")) && !clockedOut) {
    nb = `${store.get("longEnabled") ? fmtMin(longRemaining) : ""}|${store.get("microEnabled") ? fmtMin(microRemaining) : ""}|${store.get("standEnabled") ? fmtMin(standRemaining) : ""}`;
    if (snoozeUntil > Date.now()) nb = "snooze";
  }
  return [monitoring, clockedOut, updateReady, updateVersion, nb, standPhase, altAwaiting || "", store.get("cameraId") || ""].join("~");
}
function refreshMenu() {
  if (!tray) return;
  lastMenuKey = menuKey();
  tray.setContextMenu(buildMenu());
}

function buildMenu() {
  const breaksOn = store.get("microEnabled") || store.get("longEnabled");
  let nextBreak = "Breaks off";
  if (breaksOn && !clockedOut) {
    const parts = [];
    if (store.get("longEnabled")) parts.push(`stretch in ${fmtMin(longRemaining)}`);
    if (store.get("microEnabled")) parts.push(`eyes in ${fmtMin(microRemaining)}`);
    if (store.get("standEnabled")) {
      if (store.get("standMode") === "alternate")
        parts.push(altAwaiting
          ? `switch to ${altAwaiting === "stand" ? "standing" : "sitting"}…`
          : `${standPhase === "stand" ? "standing" : "sitting"} · switch in ${fmtMin(standRemaining)}`);
      else parts.push(`stand in ${fmtMin(standRemaining)}`);
    }
    nextBreak = parts.join(" · ");
    if (snoozeUntil > Date.now()) nextBreak = `snoozed ${fmtMin((snoozeUntil - Date.now()) / 1000)}`;
  }
  const statusLabel = clockedOut
    ? "Clocked out"
    : monitoring
    ? `Posture: ${postureState === "bad" ? "slouching" : postureState}`
    : "Posture: paused";

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: nextBreak, enabled: false },
    ...(altAwaiting
      ? [{ label: `✓ Yes - I'm ${altAwaiting === "stand" ? "standing" : "sitting"} now`, click: confirmSwitch }]
      : []),
    { type: "separator" },
    { label: monitoring ? "Pause monitoring" : "Resume monitoring", click: () => setMonitoring(!monitoring) },
    { label: "Calibrate posture (sit up straight)", enabled: monitoring, click: calibrate },
    { label: "Show camera / posture view", click: () => showWin("monitor") },
    {
      label: "Camera",
      submenu: [
        { label: "System default", type: "radio", checked: !store.get("cameraId"), click: () => switchCamera("") },
        ...(lastCameras.cameras || []).map((c) => ({
          label: c.label || "Camera",
          type: "radio",
          checked: (store.get("cameraId") || "") === c.id,
          click: () => switchCamera(c.id),
        })),
      ],
    },
    { type: "separator" },
    { label: `Take a stretch break  ${MOD}B`, click: () => startBreak("long", true) },
    { label: "Take an eye break", click: () => startBreak("micro", true) },
    { label: "Take a 1-minute breather", click: () => startBreak("breath", true) },
    { label: "Snooze breaks 15 min", click: () => snooze(15) },
    { label: "Reset break timers", click: resetBreakTimers },
    { type: "separator" },
    { label: "Stats dashboard…", click: () => showWin("dashboard") },
    { label: "Settings…", click: () => showWin("settings") },
    { label: "Run setup again…", click: () => { store.set("setupComplete", false); showWin("setup"); } },
    { label: "Report a problem…", click: () => showWin("report") },
    { type: "separator" },
    {
      label: updateReady ? `Restart to update → v${updateVersion}` : "Check for updates…",
      click: checkForUpdatesManual,
    },
    { type: "separator" },
    {
      label: clockedOut ? "Clock back in" : "Clock out for the day",
      click: () => { clockedOut = !clockedOut; clockedOutDay = sched.todayKey(); if (clockedOut) clearOverlayAlerts(); updateTray(); refreshMenu(); },
    },
    { label: "Quit", click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  const statusKey = clockedOut ? "clocked" : monitoring ? postureState : "off";
  // CRITICAL: updateTray() runs every posture frame (~12x/sec). Writing the tray
  // title/icon that often makes the menubar flicker AND dismisses the menu the
  // instant you open it ("menu not clickable"). Only touch the tray when the
  // visible status actually changes.
  if (statusKey === lastTrayKey) return;
  lastTrayKey = statusKey;
  if (process.platform === "darwin") {
    // macOS shows a colored emoji next to a monochrome template icon
    tray.setTitle(monitoring && !clockedOut ? ` ${EMOJI[postureState] || ""}` : clockedOut ? " 💤" : "");
  } else {
    // Windows/Linux have no tray title - convey status via a colored dot icon
    tray.setImage(makeStatusIcon(statusKey));
  }
  tray.setToolTip(`${IS_DEV ? "Backbone (Dev)" : "Backbone"} - ${clockedOut ? "clocked out" : monitoring ? postureState : "paused"}`);
  // NB: no menu rebuild here - the menu is built on click via buildMenu().
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const WINDEFS = {
  monitor: { file: "monitor.html", opts: { width: 480, height: 562, show: false, skipTaskbar: true,
    resizable: false, title: "Backbone - Camera",
    webPreferences: { backgroundThrottling: false, webSecurity: false } } },
  settings: { file: "settings.html", opts: { width: 480, height: 720, resizable: true } },
  setup: { file: "setup.html", opts: { width: 560, height: 640, resizable: false, center: true, title: "Welcome to Backbone" } },
  report: { file: "report.html", opts: { width: 440, height: 380, resizable: false, center: true, title: "Report a problem" } },
  dashboard: { file: "dashboard.html", opts: { width: 720, height: 600 } },
  overlay: { file: "overlay.html", opts: { frame: false, show: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, movable: false } },
  flash: { file: "flash.html", opts: { transparent: true, frame: false, show: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false } },
  timer: { file: "timer.html", opts: { width: 170, height: 64, transparent: true, frame: false, show: false,
    focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false } },
};

function makeWin(name) {
  const def = WINDEFS[name];
  const w = new BrowserWindow({
    title: "Backbone",
    ...def.opts,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      ...(def.opts.webPreferences || {}),
    },
  });
  w.loadFile(path.join(__dirname, "src", def.file));
  if (name === "monitor") {
    w.on("close", (e) => { if (!app.isQuitting) { e.preventDefault(); w.hide(); } });
  } else {
    w.on("closed", () => (wins[name] = null));
  }
  wins[name] = w;
  return w;
}

function getWin(name) {
  if (!wins[name] || wins[name].isDestroyed()) makeWin(name);
  return wins[name];
}
function showWin(name) {
  const w = getWin(name);
  w.show();
  w.focus();
  return w;
}

// Always-on-top helper for overlays across spaces/fullscreen apps.
function elevate(w) {
  w.setAlwaysOnTop(true, "screen-saver");
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreen: true });
}
// Cover the whole display under the cursor (borderless, no native fullscreen,
// so it floats over fullscreen apps without a Space switch).
function sizeToCursorDisplay(w) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  w.setBounds(d.bounds);
}

// ---------------------------------------------------------------------------
// Monitoring / posture
// ---------------------------------------------------------------------------
function pushConfig() {
  const w = wins.monitor;
  if (w && w.webContents) {
    w.webContents.send("monitor:config", {
      ...store.store,
      badnessThreshold: badnessThreshold(),
      proximityThreshold: proximityThreshold(),
    });
  }
}

function setMonitoring(on) {
  monitoring = on;
  postureState = on ? "init" : "paused";
  badSince = null;
  lastWatchSlouchAt = 0;
  stillSince = 0;
  if (!on) { recordSittingBout(); presentSince = 0; awaySince = 0; clearOverlayAlerts(); }
  const w = wins.monitor;
  if (w && w.webContents) w.webContents.send("monitor:setPaused", !on);
  updateTray();
  refreshMenu();
}

function calibrate() {
  const w = wins.monitor;
  if (w && w.webContents) {
    showWin("monitor"); // show the live view so they can position themselves
    w.webContents.send("monitor:calibrate");
    notify("Calibrating posture", "Sit up straight and look at your screen…", true);
  }
}

// A different camera sees different geometry, so the old baseline is invalid:
// clear it and walk them through recalibration via the coaching flow.
function invalidateCalibration() {
  store.delete("baseline");
  store.delete("deskCheck");
  const w = wins.monitor;
  if (w && w.webContents) w.webContents.send("monitor:clearBaseline");
  showWin("monitor"); // coaching flow guides them to the Calibrate button
  notify("Camera switched", "Quick recalibration needed: sit tall, then press Calibrate on the camera window.", true);
  refreshMenu();
}

// Switch cameras from the tray.
function switchCamera(id) {
  if ((store.get("cameraId") || "") === (id || "")) return;
  store.set("cameraId", id || "");
  pushConfig(); // the monitor renderer swaps the feed
  invalidateCalibration();
}

function sendSetup(channel, data) {
  if (wins.setup && !wins.setup.isDestroyed()) wins.setup.webContents.send(channel, data);
}

function onPostureUpdate(p) {
  if (!monitoring || clockedOut || isIdle) return;
  if (breakActive) return; // don't nudge/judge posture while they're stretching

  if (p.state === "uncalibrated") {
    sendSetup("setup:posture", { state: "detected", pos: p.pos }); // person visible, no baseline yet
    return;
  }
  sendSetup("setup:posture", { state: p.state });

  lastScore = p.score || 0;

  // proximity HUD ("lean back") with hysteresis so it doesn't flicker
  if (store.get("proximityAlert") && p.proximity != null) {
    const T = proximityThreshold();
    if (proximityOn && p.proximity < T * 0.7) proximityOn = false;
    else if (!proximityOn && p.proximity > T) proximityOn = true;
    flashCmd({ type: "proximity", on: proximityOn });
  } else if (proximityOn) {
    proximityOn = false;
    flashCmd({ type: "proximity", on: false });
  }

  // The detector resolves good/bad with smoothing + hysteresis; trust its state.
  if (p.state === "no-person") {
    postureState = "no-person";
    badSince = null;
    lastWatchSlouchAt = 0;
    stats.sample("no-person");
    if (!awaySince) awaySince = Date.now();
    stillSince = 0;
  } else {
    // present (good or bad) - presence bookkeeping shared by both states
    if (awaySince) {
      // Coming back from an away stretch: if they actually left (3+ min) shortly
      // after a stand prompt, credit the stand; long absences end the sitting bout.
      const awayMs = Date.now() - awaySince;
      if (awayMs >= 3 * 60 * 1000) {
        if (standPromptedAt && awaySince - standPromptedAt >= 0 && awaySince - standPromptedAt < 10 * 60 * 1000) {
          if (altAwaiting === "stand") confirmSwitch(); // they got up - treat it as "yes, standing"
          else if (store.get("standMode") !== "alternate") stats.bumpDay("stands");
          standPromptedAt = 0;
        }
        recordSittingBout();
        presentSince = 0;
      }
      awaySince = 0;
    }
    if (!presentSince) presentSince = Date.now();
    maybeVarietyNudge(p);
    if (p.state === "bad") {
      postureState = "bad";
      if (!badSince) badSince = Date.now();
      stats.sample("bad");
      maybeNudge();
      maybeWatchSlouch();
    } else {
      postureState = "good";
      badSince = null;
      lastWatchSlouchAt = 0;
      lastEscalateSound = 0;
      stats.sample("good");
    }
  }

  // Persistent yellow glow + "what to fix" cue while you're slouching (after a
  // brief grace so momentary movement doesn't flicker it); both clear when good.
  // After 30s of sustained slouching, escalate: the border flashes faster and a
  // small reminder sound repeats every few seconds until posture is corrected.
  const badMs = postureState === "bad" ? Date.now() - (badSince || Date.now()) : 0;
  const showCue = badMs > 1500;
  const escalate = badMs > 30000;
  flashCmd({ type: "glow", on: !!showCue, urgent: escalate });
  flashCmd({ type: "cue", on: !!(showCue && p.cue), text: p.cue || "" });
  if (escalate) maybeEscalateSound();

  // Tally which body areas you slouch in, to target stretch routines (throttled).
  if (showCue && Date.now() - lastTallyAt > 8000) {
    lastTallyAt = Date.now();
    const area = cueArea(p.cue);
    if (area) {
      const tally = store.get("faultTally") || {};
      tally[area] = Math.min(20, (tally[area] || 0) + 1);
      store.set("faultTally", tally);
    }
  }

  updateTray();
}

function maybeNudge() {
  if (!store.get("postureEnabled")) return;
  if (Date.now() - (badSince || Date.now()) < store.get("holdSeconds") * 1000) return;
  if (Date.now() - lastAlertAt < store.get("alertCooldownMin") * 60000) return;
  if (sched.isQuietNow(store.store)) return;
  lastAlertAt = Date.now();

  // The persistent on-screen glow + cue (driven from onPostureUpdate) is the
  // always-visible signal; here we add the periodic notification / sound.
  const style = store.get("nudgeStyle");
  if (style === "voice") playSound("voice", "Check your posture. Sit up tall.");
  else if (style !== "silent") {
    if (store.get("soundEnabled")) playSound("nudge");
    notify("Check your posture 🪑", nextNudgeMsg());
  }
}

// Rotating copy - a fixed message stops registering; variety helps long-term
// adherence (and it's cheap).
const NUDGE_MSGS = [
  "You've been slouching - reset your shoulders and lift your head.",
  "Sit tall: ears over shoulders, shoulders over hips.",
  "Unround those shoulders and lengthen the back of your neck.",
  "Quick reset - roll your shoulders back and lift your chest.",
  "Imagine a string pulling the crown of your head to the ceiling.",
  "Slide your chin back and let your spine stack up tall.",
];
let nudgeMsgIdx = 0;
function nextNudgeMsg() { return NUDGE_MSGS[nudgeMsgIdx++ % NUDGE_MSGS.length]; }

// Stand / move prompt (evidence: hourly stand prompts reliably cut sitting time).
// Lightweight by design - a notification, sound and optional watch buzz; the
// "overlay" style shows a 30s break card instead. In "alternate" mode it cues
// sit-stand desk users to switch position each interval instead.
// Seconds until the next stand event for the current mode/phase.
function standCycleSecs() {
  if (store.get("standMode") === "alternate")
    return Math.max(5, standPhase === "stand" ? store.get("altStandMin") || 15 : store.get("altSitMin") || 45) * 60;
  return Math.max(10, store.get("standIntervalMin")) * 60;
}

function startStandPrompt() {
  stats.bumpDay("standPrompts");
  standPromptedAt = Date.now();
  if (store.get("standMode") === "alternate") {
    // Cue the switch, then WAIT for the user to confirm ("yes, I switched") -
    // the next phase is timed from the confirmation, not from the cue. Gentle
    // re-prompt every 5 min until they do.
    altAwaiting = altAwaiting || (standPhase === "stand" ? "sit" : "stand");
    standRemaining = 5 * 60;
    if (!sched.isQuietNow(store.store)) promptSwitch(altAwaiting);
    refreshMenu(); // surfaces the "✓ I've switched" menu item
    return;
  }
  standRemaining = standCycleSecs();
  if (sched.isQuietNow(store.store)) return;
  const mins = store.get("standMinutes") || 5;
  if (store.get("standStyle") === "overlay") { startBreak("stand"); return; }
  if (store.get("soundEnabled")) playSound("nudge");
  notify("Stand up 🧍", `Get on your feet for ~${mins} min - stretch, grab water, or keep working standing.`);
  if (store.get("watchBreaks"))
    pushWatch("Stand up", `On your feet for ~${mins} min - move a little.`,
      { priority: Math.max(2, store.get("watchPriority") - 1), tags: "standing_person" });
}

function promptSwitch(target) {
  const up = target === "stand";
  if (store.get("soundEnabled")) playSound("nudge");
  const n = new Notification({
    title: up ? "Switch to standing 🧍" : "Switch to sitting 🪑",
    body: (up ? "Raise the desk. " : "Lower the desk and take a seat. ") +
      "Click here (or use the menu-bar ✓) once you've switched - the next timer starts from then.",
  });
  n.on("click", confirmSwitch);
  n.show();
  if (store.get("watchBreaks"))
    pushWatch(up ? "Switch to standing" : "Switch to sitting",
      up ? "Raise the desk for the next stretch of work." : "Lower the desk and sit for a while.",
      { priority: Math.max(2, store.get("watchPriority") - 1), tags: up ? "standing_person" : "chair" });
}

// The user confirmed they actually switched position - start the new phase's clock.
function confirmSwitch() {
  if (!altAwaiting) return;
  standPhase = altAwaiting;
  altAwaiting = null;
  if (standPhase === "stand") stats.bumpDay("stands");
  standRemaining = standCycleSecs();
  notify(standPhase === "stand" ? "Standing ✓" : "Sitting ✓",
    `Nice - I'll cue the next switch in ~${Math.round(standRemaining / 60)} min.`, true);
  updateTray();
  refreshMenu();
}

// After 30s of sustained slouching, play a small reminder sound every few seconds
// until posture is corrected (paired with the faster border flash). Respects the
// sound toggle and quiet hours; resets when posture recovers (lastEscalateSound).
function maybeEscalateSound() {
  if (!store.get("soundEnabled")) return;
  if (sched.isQuietNow(store.store)) return;
  if (Date.now() - lastEscalateSound < 5000) return; // every ~5s
  lastEscalateSound = Date.now();
  playSound("nudge");
}

// Close out the current continuous-sitting bout (user left / took a standing
// break) and remember today's longest for the dashboard.
function recordSittingBout() {
  if (!presentSince) return;
  const mins = Math.round((Date.now() - presentSince) / 60000);
  if (mins >= 5) stats.noteLongestSit(mins);
}

// Dynamic-posture nudge: even "good" posture held rigidly is bad - Cornell/ANSI
// explicitly recommend frequent posture changes over any single static pose. If
// the body has been essentially motionless for varietyMin, give one gentle cue.
const VARIETY_MSGS = [
  "You've been in one position a while - shift, recline, or roll your shoulders.",
  "Posture check: the best posture is the next one. Change it up.",
  "Time to move a little - re-settle into a fresh position.",
  "Shift your hips, change your lean - your spine likes variety.",
];
let varietyMsgIdx = 0;
function maybeVarietyNudge(p) {
  if (!store.get("postureVarietyEnabled")) return;
  if (p.move == null) return; // detector doesn't report movement - feature inert
  const now = Date.now();
  if (p.move > 0.012 || !stillSince) { stillSince = now; return; }
  if (now - stillSince < Math.max(5, store.get("varietyMin")) * 60000) return;
  stillSince = now; // one nudge per stretch of stillness
  if (sched.isQuietNow(store.store)) return;
  const style = store.get("nudgeStyle");
  if (style === "silent") return;
  if (store.get("soundEnabled")) playSound("nudge");
  notify("Change it up 🔄", VARIETY_MSGS[varietyMsgIdx++ % VARIETY_MSGS.length], true);
}

// Buzz the watch once posture has been continuously bad past the threshold, then
// repeat each interval until you sit up (badSince resets on good/no-person, so a
// brief correction re-arms it). Independent of the on-screen nudge cadence.
function maybeWatchSlouch() {
  if (!store.get("watchPosture")) return;
  const thresholdMs = Math.max(15, store.get("watchSlouchSec") || 60) * 1000;
  if (Date.now() - (badSince || Date.now()) < thresholdMs) return;
  if (lastWatchSlouchAt && Date.now() - lastWatchSlouchAt < thresholdMs) return; // re-buzz cadence
  if (sched.isQuietNow(store.store)) return;
  lastWatchSlouchAt = Date.now();
  pushWatch("Sit up tall 🪑", "You've been slouching for a while - lengthen your spine and roll your shoulders back.", {
    priority: store.get("watchPriority"),
    tags: "warning",
  });
}

// ---------------------------------------------------------------------------
// Flash / proximity HUD / sound  (renderer-driven)
// ---------------------------------------------------------------------------
function flashCmd(cmd) {
  // Track which on-screen alerts are active. CRITICAL: only show/position/elevate
  // the overlay window ONCE per visible session - never on every posture frame,
  // which hammered the window server and could freeze the Mac.
  if (cmd.type === "glow") glowOn = !!cmd.on;
  else if (cmd.type === "cue") cueOn = !!cmd.on;
  else if (cmd.type === "proximity") proxShown = !!cmd.on;
  else if (cmd.type === "dim") dimOn = !!cmd.on;
  const anyOn = glowOn || cueOn || proxShown || dimOn;

  // Skip the per-frame IPC when this command hasn't actually changed.
  const sig = (cmd.on ? "1" : "0") + (cmd.urgent ? "u" : "") + (cmd.level != null ? cmd.level.toFixed(2) : "") + (cmd.text || "");
  const changed = lastFlash[cmd.type] !== sig;
  lastFlash[cmd.type] = sig;

  if (!anyOn) {
    // Turn the element off immediately (instant visual feedback) but DEFER hiding
    // the window. If posture flips bad→good→bad quickly, hiding/showing the window
    // each frame strobes the screen and hammers WindowServer (the freeze bug). So
    // keep the (now-transparent) window up and only hide after a calm stretch.
    if (wins.flash && !wins.flash.isDestroyed() && changed) wins.flash.webContents.send("flash:cmd", cmd);
    if (flashShown && !flashHideTimer) {
      flashHideTimer = setTimeout(() => {
        flashHideTimer = null;
        if (!(glowOn || cueOn || proxShown || dimOn) && flashShown && wins.flash && !wins.flash.isDestroyed()) {
          wins.flash.hide();
          flashShown = false;
        }
      }, 2500);
    }
    return;
  }

  // An alert is active again - cancel any pending hide so the window stays put.
  if (flashHideTimer) { clearTimeout(flashHideTimer); flashHideTimer = null; }
  const w = getWin("flash");
  const apply = () => {
    let justShown = false;
    if (!flashShown) {
      sizeToCursorDisplay(w);
      elevate(w);
      w.setIgnoreMouseEvents(true);
      w.showInactive();
      flashShown = true;
      justShown = true; // re-assert element state after a (re)show
    }
    if (changed || justShown) w.webContents.send("flash:cmd", cmd);
  };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", apply);
  else apply();
}

// Clear every on-screen alert (glow, cue, lean-back HUD) - used whenever posture
// processing stops (paused, idle, clocked out, break) so nothing stays frozen.
function clearOverlayAlerts() {
  proximityOn = false;
  flashCmd({ type: "glow", on: false });
  flashCmd({ type: "cue", on: false });
  flashCmd({ type: "proximity", on: false });
  flashCmd({ type: "dim", on: false });
  // Explicit stop (pause/break/idle/clock-out): hide now rather than waiting for
  // the dwell timer, and drop any pending deferred hide.
  if (flashHideTimer) { clearTimeout(flashHideTimer); flashHideTimer = null; }
  if (flashShown && wins.flash && !wins.flash.isDestroyed()) wins.flash.hide();
  flashShown = false;
}

function playSound(type, text) {
  const w = getWin("monitor");
  const send = () => w.webContents.send("sound:play", { type, text, volume: store.get("soundVolume") });
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}

// ---------------------------------------------------------------------------
// Breaks
// ---------------------------------------------------------------------------
function resetBreakTimers() {
  microRemaining = store.get("microIntervalMin") * 60;
  longRemaining = store.get("longIntervalMin") * 60;
  altAwaiting = null;
  standRemaining = standCycleSecs();
  hydrationRemaining = store.get("hydrationIntervalMin") * 60;
  warnShownFor = null;
  hideCursorTimer();
  updateTray();
}

function snooze(mins) {
  snoozeUntil = Date.now() + mins * 60000;
  updateTray();
}

function startBreak(kind, manual) {
  if (breakActive) return;
  breakActive = true;
  hideCursorTimer();
  warnShownFor = null;
  badSince = null;
  lastWatchSlouchAt = 0;
  stillSince = 0;
  clearOverlayAlerts(); // no slouch glow / HUD during a break
  if (store.get("soundEnabled")) playSound("break-start");
  if (!manual && store.get("watchBreaks"))
    pushWatch(
      kind === "long" ? "Time to stretch" : kind === "stand" ? "Stand up" : "Eye break",
      kind === "long" ? "Stand up and stretch for a few minutes."
        : kind === "stand" ? `On your feet for ~${store.get("standMinutes") || 5} min - move a little.`
        : "Look at something far away for a minute.",
      { priority: Math.max(2, store.get("watchPriority") - 1),
        tags: kind === "long" ? "person_in_lotus_position" : kind === "stand" ? "standing_person" : "eyes" }
    );

  const routine = buildRoutine(kind);
  // Watchdog: if the overlay renderer crashes / never sends overlay:done, force
  // the break to end so it can't stay stuck (which would block ALL future breaks
  // and leave posture detection paused). Cap = routine length + 2 min grace.
  const totalMs = routine.reduce((a, s) => a + (s.total || s.seconds || 30), 0) * 1000;
  clearTimeout(breakWatchdog);
  breakWatchdog = setTimeout(() => { if (breakActive) endBreak(kind, true); }, totalMs + 120000);

  const w = getWin("overlay");
  const payload = {
    kind, routine,
    allowSkip: !store.get("strictBreaks") || manual,
    theme: store.get("overlayTheme"),
    voice: store.get("breakVoice"),
    sound: store.get("soundEnabled"),
    volume: store.get("soundVolume"),
  };
  const send = () => { sizeToCursorDisplay(w); elevate(w); w.show(); w.focus(); w.webContents.send("overlay:show", payload); };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}

function endBreak(kind, skipped) {
  clearTimeout(breakWatchdog);
  breakActive = false;
  if (wins.overlay) wins.overlay.hide();
  if (store.get("soundEnabled") && !skipped) playSound("break-end");
  if (kind === "long") {
    stats.bumpDay("longs");
    longRemaining = store.get("longIntervalMin") * 60;
    // a long break also satisfies the micro + stand timers (the routine involves standing)
    microRemaining = store.get("microIntervalMin") * 60;
    if (!altAwaiting) standRemaining = standCycleSecs();
    if (skipped) stats.bumpDay("skipped");
    if (!skipped) { recordSittingBout(); presentSince = 0; } // they stood for the routine
  } else if (kind === "stand") {
    if (!skipped) { stats.bumpDay("stands"); recordSittingBout(); presentSince = 0; }
    standRemaining = standCycleSecs();
  } else if (kind === "breath") {
    // a manual breather doesn't reset any schedule
  } else {
    stats.bumpDay("micros");
    microRemaining = store.get("microIntervalMin") * 60;
    if (skipped) stats.bumpDay("skipped");
  }
  updateTray();
}

// The pre-break warning surfaces (pill / dim) never take focus, so they can't get
// a keypress. Grab Esc globally just while one is up, so Esc cancels the break.
function ensurePreBreakEsc() {
  if (!preBreakEscOn) {
    try { preBreakEscOn = globalShortcut.register("Escape", cancelImminentBreak); } catch (_) {}
  }
}

// cursor-following pre-break countdown
function showCursorTimer(label, secs) {
  if (!store.get("showCursorTimer")) return;
  ensurePreBreakEsc();
  const w = getWin("timer");
  const send = () => {
    elevate(w);
    w.setIgnoreMouseEvents(true);
    positionTimerAtCursor();
    w.showInactive();
    w.webContents.send("timer:tick", { label, secs });
  };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
}
function hideCursorTimer() {
  if (wins.timer && !wins.timer.isDestroyed()) wins.timer.hide();
  flashCmd({ type: "dim", on: false }); // clear the pre-break tint (preBreakStyle "dim")
  if (preBreakEscOn) { try { globalShortcut.unregister("Escape"); } catch (_) {} preBreakEscOn = false; }
}
// Esc during the pre-break countdown: skip this break (reset its timer to a full
// interval) and dismiss the pill. Only meaningful while a warning is showing.
function cancelImminentBreak() {
  if (!warnShownFor) return;
  if (warnShownFor === "long") longRemaining = store.get("longIntervalMin") * 60;
  else microRemaining = store.get("microIntervalMin") * 60;
  warnShownFor = null;
  hideCursorTimer();
  updateTray();
}
function positionTimerAtCursor() {
  if (!wins.timer || wins.timer.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  wins.timer.setPosition(pt.x + 18, pt.y + 18);
}

// ---------------------------------------------------------------------------
// Main 1s tick: gating, idle, break countdowns
// ---------------------------------------------------------------------------
function tick() {
  // reset clock-out at day change
  if (clockedOut && clockedOutDay && clockedOutDay !== sched.todayKey()) {
    clockedOut = false;
    clockedOutDay = null;
  }

  // idle detection
  const idleSec = powerMonitor.getSystemIdleTime();
  const nowIdle = idleSec >= store.get("idlePauseSec");
  if (nowIdle && !isIdle) {
    isIdle = true;
    idleStartedAt = Date.now();
    badSince = null; // re-arm slouch timing when they come back
    lastWatchSlouchAt = 0;
    stillSince = 0;
    clearOverlayAlerts(); // don't leave a glow/cue frozen on screen while away
  } else if (!nowIdle && isIdle) {
    isIdle = false;
    // Sitting still pauses the countdown (above); only a real walk-away (5+ min)
    // should reset it - otherwise reading/watching for a minute kept wiping all
    // progress and the break never fired.
    if (store.get("idleResetBreaks") && Date.now() - idleStartedAt >= 5 * 60 * 1000) resetBreakTimers();
  }

  const working = sched.isWorkingNow(store.store);
  const breaksActive = !clockedOut && working && !isIdle && !breakActive && snoozeUntil < Date.now();

  // break countdowns
  if (breaksActive) {
    if (store.get("longEnabled")) longRemaining = Math.max(0, longRemaining - 1);
    if (store.get("microEnabled")) microRemaining = Math.max(0, microRemaining - 1);
    if (store.get("standEnabled")) standRemaining = Math.max(0, standRemaining - 1);
    if (store.get("hydrationEnabled")) hydrationRemaining = Math.max(0, hydrationRemaining - 1);

    const warn = store.get("preBreakWarnSec");
    const longDue = store.get("longEnabled") && longRemaining <= 0;
    const microDue = store.get("microEnabled") && microRemaining <= 0;

    // lightweight prompts (no overlay takeover) fire independently of the big breaks
    if (store.get("standEnabled") && standRemaining <= 0) startStandPrompt();
    if (store.get("hydrationEnabled") && hydrationRemaining <= 0) {
      hydrationRemaining = Math.max(10, store.get("hydrationIntervalMin")) * 60;
      notify("Water break 💧", "A good moment for a few sips.", true);
    }

    if (longDue) startBreak("long");
    else if (microDue) startBreak("micro");
    else {
      // pre-break warning for the nearest imminent break: cursor pill (default)
      // or a gradually deepening screen tint (evidence: gradual occlusion beats
      // abrupt interruption for actually taking the break)
      const nextKind = store.get("longEnabled") && longRemaining <= microRemaining ? "long" : "micro";
      const rem = nextKind === "long" ? longRemaining : microRemaining;
      if (store.get(nextKind === "long" ? "longEnabled" : "microEnabled") && rem <= warn && rem > 0) {
        if (store.get("preBreakStyle") === "dim") {
          ensurePreBreakEsc();
          flashCmd({ type: "dim", on: true, level: Math.min(0.4, 0.4 * (1 - rem / Math.max(1, warn))) });
        } else {
          showCursorTimer(nextKind === "long" ? "Break" : "Eyes", rem);
          positionTimerAtCursor();
        }
        warnShownFor = nextKind;
      } else if (warnShownFor) {
        hideCursorTimer();
        warnShownFor = null;
      }
    }
  } else if (warnShownFor) {
    hideCursorTimer();
    warnShownFor = null;
  }

  // working-hours auto pause/resume of posture monitoring
  if (store.get("workingHoursEnabled")) {
    if (!working && monitoring) setMonitoring(false);
    else if (working && !monitoring && store.get("startMonitoringOnLaunch") && !clockedOut) setMonitoring(true);
  }

  // Re-set the menu only when its non-posture content changes (≈ once a minute
  // as the break countdown ticks) - never on a posture flicker.
  if (menuKey() !== lastMenuKey) refreshMenu();
}

// ---------------------------------------------------------------------------
// Apple Watch / phone push via ntfy (POST to <server>/<topic>)
// ---------------------------------------------------------------------------
function asciiHeader(s) {
  // HTTP header values must be Latin-1; strip emoji/non-ASCII from the title.
  return String(s || "").replace(/[^\x20-\x7E]/g, "").trim() || "Backbone";
}

// ---------------------------------------------------------------------------
// Bug reporting helpers (delivery via Sentry - see initSentry near the top).
// Dedup + throttle + per-session cap so a looping error can't flood the project.
// ---------------------------------------------------------------------------
let reportCount = 0, lastReportAt = 0;
const reportedSigs = new Set();

function reportBug(context, message, stack) {
  if (!sentryOn) return;
  const sig = context + "|" + String(message || "").slice(0, 120);
  if (reportedSigs.has(sig)) return;            // don't resend the same error
  if (reportCount >= 25) return;                // per-session cap
  if (Date.now() - lastReportAt < 2000) return; // throttle bursts
  reportedSigs.add(sig); reportCount++; lastReportAt = Date.now();
  const err = new Error(String(message || "Error"));
  if (stack) err.stack = String(stack);
  Sentry.captureException(err, { tags: { area: context || "renderer" } });
}

function reportManual(note) {
  if (!initSentry(true)) return; // user clicked "send" - treat as consent for this report
  Sentry.captureMessage("User report: " + String(note || "(no note)").slice(0, 1000), "info");
}

function pushWatch(title, body, opts = {}) {
  const { priority = 4, tags = "warning", force = false, onResult } = opts;
  const done = (ok, detail) => onResult && onResult(ok, detail);
  // `force` lets the manual test fire even when the feature toggle is off.
  if (!force && !store.get("watchEnabled")) return done(false, "Watch buzzes are turned off in settings.");
  const topic = String(store.get("watchTopic") || "").trim();
  if (!topic) return done(false, "No ntfy topic set yet.");
  const base = String(store.get("watchServer") || "https://ntfy.sh").replace(/\/+$/, "");
  let url;
  try { url = new URL(base + "/" + encodeURIComponent(topic)); } catch (_) { return done(false, "Invalid server URL."); }
  const lib = url.protocol === "http:" ? http : https;
  const data = Buffer.from(body || "", "utf8");
  const req = lib.request(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": data.length,
        Title: asciiHeader(title),
        Priority: String(priority), // 4=high, 5=max -> reliable Watch haptic
        Tags: tags,
      },
    },
    (res) => {
      res.resume();
      res.on("end", () => done(res.statusCode === 200, res.statusCode === 200 ? "" : `ntfy responded ${res.statusCode}`));
    }
  );
  req.on("error", (e) => { console.error("[watch] push failed:", e.message); done(false, e.message); });
  req.setTimeout(8000, () => req.destroy(new Error("Request timed out - check your connection.")));
  req.write(data);
  req.end();
}

// ---------------------------------------------------------------------------
// Notifications helper
// ---------------------------------------------------------------------------
function notify(title, body, silent) {
  if (sched.isQuietNow(store.store) && !silent) return;
  new Notification({ title, body, silent: !!silent }).show();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on("posture:update", (_e, p) => onPostureUpdate(p));
ipcMain.on("monitor:ready", () => {
  pushConfig();
  const b = store.get("baseline"); // restore saved calibration (not during first-run setup)
  if (b && wins.monitor && store.get("setupComplete")) wins.monitor.webContents.send("monitor:baseline", b);
  // During first-run onboarding the wizard drives monitoring; don't auto-start.
  if (store.get("startMonitoringOnLaunch") && store.get("setupComplete")) setMonitoring(true);
});
ipcMain.on("monitor:error", (_e, msg) => {
  notify("Backbone - camera error", String(msg));
  sendSetup("setup:cameraError", String(msg)); // let onboarding offer to skip calibration
});
// Rough screen-distance estimate from the calibrated inter-eye spacing: the
// average adult IPD is ~63mm, so the fraction of the frame the eyes span plus a
// typical laptop-webcam FOV (~60° horizontal) gives distance ≈ IPD / (frac·FOV).
// Rough (FOV varies per camera) but plenty to flag "way too close" vs "fine".
function deskCheckFrom(baseline) {
  const check = {
    cameraBelow: !!baseline.cameraBelow,
    cameraOffCentre: !!baseline.cameraOffCentre,
    distanceIn: null, tooClose: false,
  };
  if (baseline.eye > 0.01 && baseline.eye < 0.5) {
    const distMM = 63 / (baseline.eye * (60 * Math.PI) / 180);
    check.distanceIn = Math.round(distMM / 25.4);
    check.tooClose = check.distanceIn < 20; // OSHA: at least 20 in, ideally 20-40
  }
  return check;
}

ipcMain.on("monitor:calibrated", (_e, baseline) => {
  let deskCheck = null;
  if (baseline && typeof baseline === "object") {
    store.set("baseline", baseline);
    deskCheck = deskCheckFrom(baseline);
    store.set("deskCheck", deskCheck);
  }
  notify("Calibration complete ✅", "Your posture baseline is set.", true);
  sendSetup("setup:calibrated", deskCheck);
  // Let "Calibration complete ✓" show briefly, then close the camera view.
  setTimeout(() => { if (wins.monitor && !wins.monitor.isDestroyed()) wins.monitor.hide(); }, 1700);
});

ipcMain.on("overlay:done", (_e, { kind, skipped }) => endBreak(kind, skipped));
ipcMain.on("overlay:postpone", (_e, { kind, mins }) => {
  clearTimeout(breakWatchdog);
  breakActive = false;
  if (wins.overlay) wins.overlay.hide();
  if (kind === "long") longRemaining = (mins || 5) * 60;
  else if (kind === "stand") standRemaining = (mins || 5) * 60;
  else if (kind !== "breath") microRemaining = (mins || 5) * 60;
  updateTray();
});

ipcMain.handle("settings:get", () => ({ ...store.store, badnessThreshold: badnessThreshold() }));
const SETTING_MINS = { microIntervalMin: 1, longIntervalMin: 5, microDurationSec: 5, longDurationSec: 30,
  holdSeconds: 3, alertCooldownMin: 1, reminderIntervalMin: 5, idlePauseSec: 15, preBreakWarnSec: 0,
  watchSlouchSec: 15, standIntervalMin: 10, standMinutes: 1, varietyMin: 5, hydrationIntervalMin: 10,
  altSitMin: 10, altStandMin: 5 };
ipcMain.handle("settings:set", (_e, patch) => {
  // Clamp numeric settings - a cleared field arrives as 0 and a 0 interval/hold
  // would fire a break/nudge every tick (a storm). Floor each to a safe minimum.
  for (const [k, lo] of Object.entries(SETTING_MINS)) {
    if (k in patch) { const n = Number(patch[k]); patch[k] = Number.isFinite(n) ? Math.max(lo, n) : lo; }
  }
  const prevCam = store.get("cameraId") || "";
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  // Camera changed after setup: the calibration belongs to the old camera.
  if ("cameraId" in patch && (store.get("cameraId") || "") !== prevCam &&
      store.get("setupComplete") && store.get("baseline")) invalidateCalibration();
  if ("microIntervalMin" in patch) microRemaining = store.get("microIntervalMin") * 60;
  if ("longIntervalMin" in patch) longRemaining = store.get("longIntervalMin") * 60;
  if (["standIntervalMin", "standEnabled", "standMode", "altSitMin", "altStandMin"].some((k) => k in patch)) {
    altAwaiting = null;
    standRemaining = standCycleSecs();
  }
  if ("hydrationIntervalMin" in patch || "hydrationEnabled" in patch) hydrationRemaining = store.get("hydrationIntervalMin") * 60;
  if ("launchAtLogin" in patch) applyLoginItem();
  if ("bugReports" in patch) {
    if (patch.bugReports) initSentry();
    else if (sentryOn) { try { Sentry.close(); } catch (_) {} sentryOn = false; }
  }
  pushConfig();
  updateTray();
  return { ...store.store, badnessThreshold: badnessThreshold() };
});
// Stretch library: list with enabled state, toggle, and reset.
ipcMain.handle("stretch:library", () => {
  const disabled = store.get("disabledStretches") || [];
  return STRETCH_LIBRARY.map((s) => ({
    id: s.id, name: s.name, area: s.area,
    detail: s.mode === "side" ? `${s.perSideSec}s per side` : s.mode === "reps" ? `${s.repsPerSide} reps per side` : `${s.seconds}s`,
    enabled: !disabled.includes(s.id),
  }));
});
ipcMain.handle("stretch:toggle", (_e, { id, enabled }) => {
  const set = new Set(store.get("disabledStretches") || []);
  enabled ? set.delete(id) : set.add(id);
  store.set("disabledStretches", [...set]);
  return [...set];
});
ipcMain.handle("stretch:reset", () => {
  store.set("disabledStretches", []);
  return [];
});
ipcMain.handle("stats:get", () => stats.summary());
ipcMain.on("window:close", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) (w === wins.monitor ? w.hide() : w.close());
});
ipcMain.on("break:test", (_e, kind) => startBreak(kind || "long", true));

// ---- camera list (from the monitor renderer) -----------------------------
let lastCameras = { cameras: [], active: "" };
ipcMain.on("cameras:list", (_e, data) => {
  const changed = JSON.stringify((data || {}).cameras) !== JSON.stringify(lastCameras.cameras);
  lastCameras = data || lastCameras;
  ["setup", "settings"].forEach((n) => {
    const w = wins[n];
    if (w && !w.isDestroyed()) w.webContents.send("cameras:list", lastCameras);
  });
  if (changed) refreshMenu(); // keep the tray's Camera submenu current
});
ipcMain.handle("cameras:get", () => lastCameras);

// ---- bug reporting --------------------------------------------------------
ipcMain.on("report:error", (_e, info) => reportBug((info && info.context) || "renderer", info && info.message, info && info.stack));
ipcMain.on("report:send", (e, note) => {
  reportManual(note);
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
  notify("Report sent ✓", "Thanks - this helps me fix it.", true);
});

// ---- first-run setup wizard ----------------------------------------------
ipcMain.on("setup:setMonitoring", (_e, on) => setMonitoring(!!on));
ipcMain.on("setup:calibrate", () => calibrate());
ipcMain.on("setup:showCamera", (_e, on) => {
  if (on) showWin("monitor");
  else if (wins.monitor && !wins.monitor.isDestroyed()) wins.monitor.hide();
});
ipcMain.on("setup:done", () => {
  store.set("setupComplete", true);
  if (wins.setup && !wins.setup.isDestroyed()) wins.setup.close();
  if (wins.monitor && !wins.monitor.isDestroyed()) wins.monitor.hide();
  if (!monitoring && store.get("startMonitoringOnLaunch")) setMonitoring(true);
  showWin("settings"); // let them fine-tune right away
  notify("Backbone is on", "I'm in your menu bar, watching your posture. 🦴", true);
});
ipcMain.on("watch:test", (e) => {
  const sender = e.sender;
  pushWatch("Backbone test", "If you felt this on your wrist, it's working! 🎉", {
    priority: store.get("watchPriority"),
    tags: "white_check_mark",
    force: true,
    onResult: (ok, detail) => {
      if (ok)
        notify("Test buzz sent ✓", "Check your phone & watch. No buzz? Open the ntfy app and confirm you subscribed to your exact topic.", true);
      else notify("Test buzz didn't send", detail || "Couldn't reach ntfy.", true);
      if (sender && !sender.isDestroyed()) sender.send("watch:testResult", { ok, detail });
    },
  });
});

// ---------------------------------------------------------------------------
// Login item / shortcuts
// ---------------------------------------------------------------------------
function applyLoginItem() {
  // Note: fails for an unsigned dev binary ("operation not permitted");
  // works once the app is signed/packaged.
  try {
    const want = !!store.get("launchAtLogin");
    if (want !== app.getLoginItemSettings().openAtLogin)
      app.setLoginItemSettings({ openAtLogin: want });
  } catch (_) {}
}
function registerShortcuts() {
  // CommandOrControl => Cmd on macOS, Ctrl on Windows/Linux
  const shortcuts = {
    "CommandOrControl+Alt+B": () => startBreak("long", true),
    "CommandOrControl+Alt+P": () => setMonitoring(!monitoring),
    "CommandOrControl+Alt+S": () => snooze(15),
  };
  const failed = [];
  for (const [accel, fn] of Object.entries(shortcuts)) {
    let ok = false;
    try { ok = globalShortcut.register(accel, fn); } catch (_) {}
    if (!ok) failed.push(accel);
  }
  // If another app already owns one of these, it silently won't fire - surface it.
  if (failed.length && sentryOn) Sentry.captureMessage("Global shortcut registration failed: " + failed.join(", "), "warning");
}

// ---------------------------------------------------------------------------
// Auto-update (electron-updater, GitHub Releases feed)
// ---------------------------------------------------------------------------
function initAutoUpdate() {
  if (!app.isPackaged) return; // updater only runs in a packaged build
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    updateReady = true;
    updateVersion = info.version;
    updateTray();
    const n = new Notification({
      title: "Backbone update ready",
      body: `Version ${info.version} downloaded - click to restart and install.`,
    });
    n.on("click", installUpdate);
    n.show();
  });
  autoUpdater.on("error", (e) => console.error("[update]", e && e.message));

  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

function installUpdate() {
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
}

function checkForUpdatesManual() {
  if (updateReady) return installUpdate();
  if (!app.isPackaged) {
    notify("Backbone", "Updates only run in the installed app, not in dev.", true);
    return;
  }
  if (checkingUpdate) return;
  checkingUpdate = true;
  autoUpdater
    .checkForUpdates()
    .then((r) => {
      const v = r && r.updateInfo && r.updateInfo.version;
      if (v && v !== app.getVersion())
        notify("Backbone", `Downloading update ${v}…`, true);
      else notify("Backbone", "You're on the latest version.", true);
    })
    .catch(() => notify("Backbone", "Couldn't check for updates right now.", true))
    .finally(() => (checkingUpdate = false));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // Only one copy of this app may run (prevents a second instance fighting over
  // the camera / global shortcuts). A duplicate launch just exits.
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  let lastSecondInstance = 0;
  app.on("second-instance", () => {
    // If another copy keeps trying to launch (e.g. an old build still in Login
    // Items after replacing the app), don't let it strobe a window open.
    if (Date.now() - lastSecondInstance < 4000) return;
    lastSecondInstance = Date.now();
    const w = (!store.get("setupComplete") && wins.setup) || wins.settings;
    if (w && !w.isDestroyed() && !w.isVisible()) w.show();
  });
  // Required for Windows toast notifications to show the app name/icon and fire
  // their click handlers; harmless on macOS.
  app.setAppUserModelId("io.milkshake.backbone");
  if (!store.get("installId")) store.set("installId", crypto.randomUUID()); // anonymous report id

  // Grant the webcam request from our own renderer (required on Windows/Linux,
  // harmless on macOS where the OS prompt still governs access).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  try { if (process.platform === "darwin") await systemPreferences.askForMediaAccess("camera"); } catch (_) {}
  if (app.dock) app.dock.hide();

  tray = new Tray(makeTrayIcon());
  refreshMenu(); // macOS opens the menu natively on click
  // Windows/Linux only open the context menu on right-click; wire left-click too.
  if (process.platform !== "darwin") tray.on("click", () => tray.popUpContextMenu());
  resetBreakTimers();
  updateTray();
  makeWin("monitor");
  applyLoginItem();
  registerShortcuts();
  initAutoUpdate();
  if (!store.get("setupComplete")) showWin("setup"); // first-run guided setup
  setInterval(tick, 1000);
  // smooth cursor-following for the pre-break countdown pill
  setInterval(() => {
    if (wins.timer && !wins.timer.isDestroyed() && wins.timer.isVisible()) positionTimerAtCursor();
  }, 60);
});

app.on("before-quit", () => { app.isQuitting = true; stats.flush(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {});
