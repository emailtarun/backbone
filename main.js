const {
  app, BrowserWindow, Tray, Menu, Notification, ipcMain,
  nativeImage, systemPreferences, powerMonitor, globalShortcut, screen,
} = require("electron");
const { session } = require("electron");
const path = require("path");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const Store = require("electron-store");
const { autoUpdater } = require("electron-updater");
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
    cue: "Drop your chin and roll your head in slow, easy circles — one way, then the other." },
  { id: "trap-stretch", name: "Trap stretch", area: "side", anim: "traptilt", mode: "side", perSideSec: 30,
    cue: "Ear toward shoulder, let the hand rest on your head for a gentle pull down the side of your neck." },
  { id: "chin-tucks", name: "Chin tucks", area: "neck", anim: "chintuck", mode: "time", seconds: 30,
    cue: "Glide your chin straight back to make a “double chin”, hold a beat, release. Repeat slowly." },
  { id: "shoulder-rolls", name: "Shoulder rolls", area: "shoulders", anim: "shoulderroll", mode: "time", seconds: 30,
    cue: "Lift your shoulders to your ears, then roll them back and down in big slow circles." },
  { id: "bow-and-arrow", name: "Bow and arrow", area: "shoulders", anim: "bowarrow", mode: "reps", repsPerSide: 5,
    cue: "One arm reaches forward, the other draws back like pulling a bowstring — open the chest as you pull." },
  { id: "open-book", name: "Open book", area: "upperback", anim: "openbook", mode: "time", seconds: 45,
    cue: "Arms out front, palms together. Sweep the top arm open like a book and follow it with your eyes. Alternate sides." },
  { id: "spinal-twist", name: "Seated spinal twist", area: "upperback", anim: "twist", mode: "side", perSideSec: 20,
    cue: "Hand to the opposite knee and twist gently from the waist. Lengthen up as you turn." },
  { id: "chest-opener", name: "Chest opener", area: "chest", anim: "chestopen", mode: "time", seconds: 30,
    cue: "Clasp your hands behind your back, lift them slightly and squeeze your shoulder blades together." },
  { id: "overhead-reach", name: "Overhead reach", area: "fullbody", anim: "reachup", mode: "time", seconds: 30,
    cue: "Interlace your fingers and press your palms to the ceiling — lengthen your whole spine." },
  { id: "stand-fold", name: "Stand & fold", area: "fullbody", anim: "standfold", mode: "time", seconds: 30,
    cue: "Stand and reach tall overhead, then slowly fold forward and let your head and arms hang." },
  { id: "wrist-stretch", name: "Wrist & finger stretch", area: "wrists", anim: "wrist", mode: "side", perSideSec: 15,
    cue: "Extend one arm, fingers up then down, and gently draw them back with your other hand." },
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
    return [{ id: "eye-rest", name: "Eye break", area: "eyes", anim: "eyes", mode: "time",
      seconds: store.get("microDurationSec") || 20, total: store.get("microDurationSec") || 20,
      cue: "Look at something ~20 feet away and blink slowly — let your eyes fully relax." }];
  }
  const disabled = store.get("disabledStretches") || [];
  const enabled = STRETCH_LIBRARY.filter((s) => !disabled.includes(s.id));
  const tally = store.get("faultTally") || {};
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
  // gentle decay so the targeting keeps adapting
  const decayed = {};
  for (const k of Object.keys(tally)) decayed[k] = tally[k] * 0.8;
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
    // breaks
    microEnabled: true,
    microIntervalMin: 20,
    microDurationSec: 20,
    longEnabled: true,
    longIntervalMin: 50,
    longDurationSec: 180,
    preBreakWarnSec: 10,
    strictBreaks: false,
    showCursorTimer: true,
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
    watchBreaks: false,
    watchPriority: 4, // ntfy priority: 2 low · 3 normal · 4 strong · 5 urgent
    // system / appearance
    launchAtLogin: false,
    startMonitoringOnLaunch: true,
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

function badnessThreshold() {
  // Lenient by default (50 -> ~47); higher sensitivity lowers it (stricter).
  return 75 - (store.get("sensitivity") / 100) * 55;
}
function proximityThreshold() {
  // Less sensitive by default (50 -> ~47); needs a clear lean-in, not a small one.
  return 70 - (store.get("proximitySensitivity") / 100) * 45;
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

let clockedOut = false;
let clockedOutDay = null;
let isIdle = false;
let breakActive = false;
let snoozeUntil = 0;

let microRemaining = 0; // seconds
let longRemaining = 0;
let warnShownFor = null; // 'micro' | 'long' | null

let updateReady = false; // a downloaded update is waiting to install
let updateVersion = "";
let checkingUpdate = false;
let lastMenuSig = null; // dedupe tray menu rebuilds (rebuilding closes an open menu)
let lastTallyAt = 0; // throttle posture-fault tallying
let proximityOn = false; // "lean back" HUD state (hysteresis)

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

function rebuildMenu() {
  const breaksOn = store.get("microEnabled") || store.get("longEnabled");
  let nextBreak = "Breaks off";
  if (breaksOn && !clockedOut) {
    const parts = [];
    if (store.get("longEnabled")) parts.push(`long in ${fmtMin(longRemaining)}`);
    if (store.get("microEnabled")) parts.push(`micro in ${fmtMin(microRemaining)}`);
    nextBreak = parts.join(" · ");
    if (snoozeUntil > Date.now()) nextBreak = `snoozed ${fmtMin((snoozeUntil - Date.now()) / 1000)}`;
  }
  const statusLabel = clockedOut
    ? "Clocked out"
    : monitoring
    ? `Posture: ${postureState === "bad" ? "slouching" : postureState}`
    : "Posture: paused";

  // Only rebuild the menu when its visible text changes — rebuilding while the
  // menu is open closes it, which made it "disappear" on click.
  const sig = [statusLabel, nextBreak, monitoring, clockedOut, updateReady, updateVersion].join("|");
  if (sig === lastMenuSig) return;
  lastMenuSig = sig;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { label: nextBreak, enabled: false },
      { type: "separator" },
      { label: monitoring ? "Pause monitoring" : "Resume monitoring", click: () => setMonitoring(!monitoring) },
      { label: "Calibrate posture (sit up straight)", enabled: monitoring, click: calibrate },
      { label: "Show camera / posture view", click: () => showWin("monitor") },
      { type: "separator" },
      { label: `Take long break now  ${MOD}B`, click: () => startBreak("long", true) },
      { label: "Take micro break now", click: () => startBreak("micro", true) },
      { label: "Snooze breaks 15 min", click: () => snooze(15) },
      { label: "Reset break timers", click: resetBreakTimers },
      { type: "separator" },
      { label: "Stats dashboard…", click: () => showWin("dashboard") },
      { label: "Settings…", click: () => showWin("settings") },
      { type: "separator" },
      {
        label: updateReady ? `Restart to update → v${updateVersion}` : "Check for updates…",
        click: checkForUpdatesManual,
      },
      { type: "separator" },
      {
        label: clockedOut ? "Clock back in" : "Clock out for the day",
        click: () => { clockedOut = !clockedOut; clockedOutDay = sched.todayKey(); updateTray(); },
      },
      { label: "Quit", click: () => app.quit() },
    ])
  );
}

function updateTray() {
  if (!tray) return;
  const statusKey = clockedOut ? "clocked" : monitoring ? postureState : "off";
  if (process.platform === "darwin") {
    // macOS shows a colored emoji next to a monochrome template icon
    tray.setTitle(monitoring && !clockedOut ? ` ${EMOJI[postureState] || ""}` : clockedOut ? " 💤" : "");
  } else {
    // Windows/Linux have no tray title — convey status via a colored dot icon
    tray.setImage(makeStatusIcon(statusKey));
  }
  tray.setToolTip(`Backbone — ${clockedOut ? "clocked out" : monitoring ? postureState : "paused"}`);
  rebuildMenu();
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const WINDEFS = {
  monitor: { file: "monitor.html", opts: { width: 480, height: 562, show: false, skipTaskbar: true,
    resizable: false, title: "Backbone — Camera",
    webPreferences: { backgroundThrottling: false, webSecurity: false } } },
  settings: { file: "settings.html", opts: { width: 480, height: 720, resizable: true } },
  setup: { file: "setup.html", opts: { width: 560, height: 640, resizable: false, center: true, title: "Welcome to Backbone" } },
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
  if (!on) { proximityOn = false; flashCmd({ type: "glow", on: false }); flashCmd({ type: "cue", on: false }); flashCmd({ type: "proximity", on: false }); }
  const w = wins.monitor;
  if (w && w.webContents) w.webContents.send("monitor:setPaused", !on);
  updateTray();
}

function calibrate() {
  const w = wins.monitor;
  if (w && w.webContents) {
    showWin("monitor"); // show the live view so they can position themselves
    w.webContents.send("monitor:calibrate");
    notify("Calibrating posture", "Sit up straight and look at your screen…", true);
  }
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
    stats.sample("no-person");
  } else if (p.state === "bad") {
    postureState = "bad";
    if (!badSince) badSince = Date.now();
    stats.sample("bad");
    maybeNudge();
  } else {
    postureState = "good";
    badSince = null;
    stats.sample("good");
  }

  // Persistent yellow glow + "what to fix" cue while you're slouching (after a
  // brief grace so momentary movement doesn't flicker it); both clear when good.
  const showCue = postureState === "bad" && Date.now() - (badSince || Date.now()) > 1500;
  flashCmd({ type: "glow", on: !!showCue });
  flashCmd({ type: "cue", on: !!(showCue && p.cue), text: p.cue || "" });

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

  if (store.get("watchPosture"))
    pushWatch("Fix your posture", "You've been slouching — sit up tall and roll your shoulders back.", {
      priority: store.get("watchPriority"),
      tags: "warning",
    });

  // The persistent on-screen glow + cue (driven from onPostureUpdate) is the
  // always-visible signal; here we add the periodic notification / sound.
  const style = store.get("nudgeStyle");
  if (style === "voice") playSound("voice", "Check your posture. Sit up tall.");
  else if (style !== "silent") {
    if (store.get("soundEnabled")) playSound("nudge");
    notify("Check your posture 🪑", "You've been slouching — reset your shoulders and lift your head.");
  }
}

// ---------------------------------------------------------------------------
// Flash / proximity HUD / sound  (renderer-driven)
// ---------------------------------------------------------------------------
function flashCmd(cmd) {
  // don't spin up the overlay just to turn an alert off
  if ((cmd.type === "proximity" || cmd.type === "cue" || cmd.type === "glow") && !cmd.on && (!wins.flash || wins.flash.isDestroyed())) return;
  const w = getWin("flash");
  const send = () => { sizeToCursorDisplay(w); elevate(w); w.showInactive(); w.setIgnoreMouseEvents(true); w.webContents.send("flash:cmd", cmd); };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send);
  else send();
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
  proximityOn = false;
  flashCmd({ type: "glow", on: false }); // no slouch glow / HUD during a break
  flashCmd({ type: "cue", on: false });
  flashCmd({ type: "proximity", on: false });
  if (store.get("soundEnabled")) playSound("break-start");
  if (!manual && store.get("watchBreaks"))
    pushWatch(
      kind === "long" ? "Time to stretch" : "Eye break",
      kind === "long" ? "Stand up and stretch for a few minutes." : "Look ~20 ft away for 20 seconds.",
      { priority: Math.max(2, store.get("watchPriority") - 1), tags: kind === "long" ? "person_in_lotus_position" : "eyes" }
    );

  const w = getWin("overlay");
  const payload = {
    kind,
    routine: buildRoutine(kind),
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
  breakActive = false;
  if (wins.overlay) wins.overlay.hide();
  if (store.get("soundEnabled") && !skipped) playSound("break-end");
  if (kind === "long") { stats.bumpDay("longs"); longRemaining = store.get("longIntervalMin") * 60; }
  else { stats.bumpDay("micros"); microRemaining = store.get("microIntervalMin") * 60; }
  if (skipped) stats.bumpDay("skipped");
  // a long break also satisfies the micro timer
  if (kind === "long") microRemaining = store.get("microIntervalMin") * 60;
  updateTray();
}

// cursor-following pre-break countdown
function showCursorTimer(label, secs) {
  if (!store.get("showCursorTimer")) return;
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
    if (store.get("idleResetBreaks")) resetBreakTimers();
  } else if (!nowIdle && isIdle) {
    isIdle = false;
  }

  const working = sched.isWorkingNow(store.store);
  const breaksActive = !clockedOut && working && !isIdle && !breakActive && snoozeUntil < Date.now();

  // break countdowns
  if (breaksActive) {
    if (store.get("longEnabled")) longRemaining = Math.max(0, longRemaining - 1);
    if (store.get("microEnabled")) microRemaining = Math.max(0, microRemaining - 1);

    const warn = store.get("preBreakWarnSec");
    const longDue = store.get("longEnabled") && longRemaining <= 0;
    const microDue = store.get("microEnabled") && microRemaining <= 0;

    if (longDue) startBreak("long");
    else if (microDue) startBreak("micro");
    else {
      // pre-break cursor countdown for the nearest imminent break
      const nextKind = store.get("longEnabled") && longRemaining <= microRemaining ? "long" : "micro";
      const rem = nextKind === "long" ? longRemaining : microRemaining;
      if (store.get(nextKind === "long" ? "longEnabled" : "microEnabled") && rem <= warn && rem > 0) {
        showCursorTimer(nextKind === "long" ? "Break" : "Eyes", rem);
        positionTimerAtCursor();
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

  // keep the tray break countdown fresh roughly every 5s
  if (Math.floor(Date.now() / 1000) % 5 === 0) updateTray();
}

// ---------------------------------------------------------------------------
// Apple Watch / phone push via ntfy (POST to <server>/<topic>)
// ---------------------------------------------------------------------------
function asciiHeader(s) {
  // HTTP header values must be Latin-1; strip emoji/non-ASCII from the title.
  return String(s || "").replace(/[^\x20-\x7E]/g, "").trim() || "Backbone";
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
  req.setTimeout(8000, () => req.destroy(new Error("Request timed out — check your connection.")));
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
ipcMain.on("monitor:error", (_e, msg) => notify("Backbone — camera error", String(msg)));
ipcMain.on("monitor:calibrated", (_e, baseline) => {
  if (baseline && typeof baseline === "object") store.set("baseline", baseline);
  notify("Calibrated ✅", "Baseline captured.", true);
  sendSetup("setup:calibrated");
});

ipcMain.on("overlay:done", (_e, { kind, skipped }) => endBreak(kind, skipped));
ipcMain.on("overlay:postpone", (_e, { kind, mins }) => {
  breakActive = false;
  if (wins.overlay) wins.overlay.hide();
  if (kind === "long") longRemaining = (mins || 5) * 60;
  else microRemaining = (mins || 5) * 60;
  updateTray();
});

ipcMain.handle("settings:get", () => ({ ...store.store, badnessThreshold: badnessThreshold() }));
ipcMain.handle("settings:set", (_e, patch) => {
  const before = { micro: store.get("microIntervalMin"), long: store.get("longIntervalMin") };
  for (const [k, v] of Object.entries(patch)) store.set(k, v);
  if (patch.microIntervalMin && patch.microIntervalMin !== before.micro) microRemaining = patch.microIntervalMin * 60;
  if (patch.longIntervalMin && patch.longIntervalMin !== before.long) longRemaining = patch.longIntervalMin * 60;
  if ("launchAtLogin" in patch) applyLoginItem();
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
  lastCameras = data || lastCameras;
  ["setup", "settings"].forEach((n) => {
    const w = wins[n];
    if (w && !w.isDestroyed()) w.webContents.send("cameras:list", lastCameras);
  });
});
ipcMain.handle("cameras:get", () => lastCameras);

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
        notify("Test buzz sent ✓", "Check your phone & Watch. No buzz? Open the ntfy app and confirm you subscribed to your exact topic.", true);
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
  globalShortcut.register("CommandOrControl+Alt+B", () => startBreak("long", true));
  globalShortcut.register("CommandOrControl+Alt+P", () => setMonitoring(!monitoring));
  globalShortcut.register("CommandOrControl+Alt+S", () => snooze(15));
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
      body: `Version ${info.version} downloaded — click to restart and install.`,
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
  // Grant the webcam request from our own renderer (required on Windows/Linux,
  // harmless on macOS where the OS prompt still governs access).
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media"));
  try { if (process.platform === "darwin") await systemPreferences.askForMediaAccess("camera"); } catch (_) {}
  if (app.dock) app.dock.hide();

  tray = new Tray(makeTrayIcon());
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
