# Backbone

A macOS menu-bar app that watches your sitting posture through your webcam and
keeps you moving — slouch nudges, eye breaks, stretch breaks, and habit stats.
All vision runs **on-device** (Google MediaPipe Pose). No video is recorded or
uploaded; only numeric posture metrics are stored locally.

## Run it

```bash
cd ~/posture-coach
npm install        # already done if node_modules/ exists
npm start
```

First launch asks for **camera permission**. A glyph appears in your menu bar.

## Features

### Posture monitoring
- Calibrated slouch detection (shoulders / ears / nose vs. your "good" baseline)
- Real-time 0–100 posture score; menu-bar status 🟢 🟡 ⚪️
- **"Lean back" proximity HUD** when you creep toward the screen
- Nudge styles: notification · screen flash · spoken voice · silent
- Sensitivity, slouch-hold time, and nudge cooldown — all tunable

### Breaks
- **Micro eye breaks** (20-20-20 rule) and **long stretch breaks** on
  independent, Pomodoro-style intervals
- Fullscreen break overlay with countdown ring and on-screen guidance
- **Editable stretch routine** (add / remove / reorder cues and durations)
- Pre-break **cursor-following countdown** pill
- Skip / postpone, or **strict mode** (no skipping)
- Sound cues (start/end chimes) with volume control

### Schedule & smart pause
- **Working hours** per weekday — auto-pauses outside them
- **Quiet hours** — suppresses nudges
- **Idle auto-pause** + optional break-timer reset when you step away
- **Clock out for the day** to stop everything until tomorrow

### Stats
- Daily **streak**, today's good-posture %, good minutes, break counts
- 7-day bar chart, last-5-minutes sparkline (Stats dashboard)

### System
- Lives in the menu bar, no dock icon
- Global shortcuts: **⌥⌘B** long break · **⌥⌘P** pause/resume · **⌥⌘S** snooze 15m
- Launch at login (once signed/packaged)
- Light/dark aware; five break overlay themes (default: slate)

## Privacy

Frames are processed in memory by an on-device model and discarded. Nothing
leaves the machine; it works fully offline. Only minute-level numeric posture
buckets and daily rollups are saved (to `electron-store`).

## Menu

Click the menu-bar icon: pause/resume · **Calibrate posture** · show camera ·
take break now · snooze · reset timers · **Stats dashboard** · **Settings** ·
clock out · quit.

## Tuning & internals

- Detection model: `pose_landmarker_lite.task`. Swap to `_full`/`_heavy`
  (URL in `scripts/fetch-model.js`, path in `src/monitor.js`) for accuracy at
  higher CPU cost.
- Posture math + weights: `src/monitor.js` and `weights` in `main.js`.
- Stats storage & aggregation: `lib/stats.js`. Schedule logic: `lib/schedule.js`.

## Files

| File | Role |
|---|---|
| `main.js` | tray, scheduling, breaks, idle/schedule gating, IPC |
| `src/monitor.*` | hidden webcam window: pose detection, scoring, sound |
| `src/overlay.*` | fullscreen break overlay + exercises |
| `src/flash.*` | posture-flash border + proximity HUD (click-through) |
| `src/timer.*` | cursor-following pre-break countdown |
| `src/dashboard.*` | stats & charts |
| `src/settings.*` | all preferences + routine editor |
| `lib/stats.js`, `lib/schedule.js` | persistence & time logic |

## Platform support

Runs on **macOS and Windows** (Linux should work too). Platform-specific bits
are handled in `main.js`: macOS shows a colored emoji in the menu bar, Windows/
Linux show a colored tray dot; global shortcuts use `CommandOrControl+Alt+…`
(Cmd on Mac, Ctrl on Windows); a session permission handler grants the webcam on
Windows. Everything else (MediaPipe, breaks, ntfy push, idle pause) is shared.

## Packaging

Configured with [`electron-builder`](https://www.electronbuilder.io/) (see the
`build` block in `package.json`). `asar` is disabled so the bundled model/wasm
load reliably via `file://`.

```bash
npm run dist:mac    # -> dist/  .dmg + .zip   (verified working)
npm run dist:win    # -> dist/  NSIS .exe installer
```

- **macOS** builds and runs from the bundle today (model + wasm load verified).
  For distribution to others, add Apple code-signing + notarization creds.
- **Windows**: run `npm run dist:win` **on a Windows machine** (or CI). Building
  the `.exe` from macOS needs Wine; a Windows runner or GitHub Actions matrix is
  the clean path.

### Branding / icons

The Backbone spine icon is generated procedurally — `npm run make-icons` writes
`build/icon.png` (1024²), and `build/icon.icns` is built from it via
`iconutil`. electron-builder uses `icon.icns` (Mac) and converts `icon.png` for
the Windows `.ico`. The menu-bar glyph is drawn in code (`drawSpine` in
`main.js`). Brand colors: slate `#334155`, coral accent `#FB7185`.

`LSUIElement` is set so the packaged Mac app stays a menu-bar agent (no dock
icon). Launch-at-login works once the app is signed/packaged.
