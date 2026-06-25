// Notarize + staple Backbone.app manually, separate from electron-builder.
const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const APP = path.join(__dirname, "../dist/mac-arm64/Backbone.app");
const ZIP = path.join(__dirname, "../dist/notarize-upload.zip");

const appleId = process.env.APPLE_ID;
const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const teamId = process.env.APPLE_TEAM_ID;

if (!appleId || !password || !teamId) {
  console.error("Missing APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID");
  process.exit(1);
}
if (!fs.existsSync(APP)) {
  console.error("App not found:", APP, "— run npm run dist:mac first");
  process.exit(1);
}

console.log("Zipping app for notarization…");
if (fs.existsSync(ZIP)) fs.unlinkSync(ZIP);
execSync(`ditto -c -k --keepParent "${APP}" "${ZIP}"`, { stdio: "inherit" });

console.log("Submitting to Apple notarytool…");
const submit = spawnSync("xcrun", [
  "notarytool", "submit", ZIP,
  "--apple-id", appleId,
  "--password", password,
  "--team-id", teamId,
  "--wait",
], { stdio: "inherit", encoding: "utf8" });

if (submit.status !== 0) {
  console.error("Notarization submission failed");
  process.exit(1);
}

console.log("Stapling ticket to app…");
const staple = spawnSync("xcrun", ["stapler", "staple", APP], { stdio: "inherit" });
if (staple.status !== 0) {
  console.error("Stapling failed");
  process.exit(1);
}

console.log("Verifying…");
execSync(`spctl --assess --type exec --verbose "${APP}"`, { stdio: "inherit" });
console.log("✅ Notarized and stapled successfully.");
