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

  // The packer may hardlink/symlink the already-collected files into the app, so
  // they share inodes with the source — cpSync would then throw EINVAL ("src and
  // dest cannot be the same"). Remove the destination first, then copy fresh
  // real files so the bundle is self-contained.
  try {
    const st = fs.lstatSync(dst);
    if (st.isSymbolicLink()) fs.unlinkSync(dst);
    else fs.rmSync(dst, { recursive: true, force: true });
  } catch (_) {}
  fs.cpSync(src, dst, { recursive: true });
  console.log("[afterPack] synced @sentry ->", dst);
};
