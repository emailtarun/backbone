// electron-builder's production-dependency collector drops some deduped
// transitive packages (e.g. @sentry/browser-utils), which crashes the app on
// launch with "Cannot find module". Copy the whole @sentry tree from source
// into the packaged app so every (sub)dependency is present, regardless of the
// collector's quirks. Runs for both macOS and Windows builds.
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const appName = packager.appInfo.productFilename; // "Backbone"
  const resApp =
    electronPlatformName === "darwin"
      ? path.join(appOutDir, `${appName}.app`, "Contents", "Resources", "app")
      : path.join(appOutDir, "resources", "app");

  const src = path.join(__dirname, "..", "node_modules", "@sentry");
  const dst = path.join(resApp, "node_modules", "@sentry");
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dst, { recursive: true });
  console.log("[afterPack] synced @sentry ->", dst);
};
