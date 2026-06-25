// Re-download the pose model and refresh the local wasm runtime if missing.
const fs = require("fs");
const path = require("path");
const https = require("https");

const root = path.join(__dirname, "..");
const modelPath = path.join(root, "models", "pose_landmarker_lite.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (e) => reject(e));
  });
}

(async () => {
  if (!fs.existsSync(modelPath) || fs.statSync(modelPath).size < 100000) {
    console.log("Downloading pose model…");
    await download(MODEL_URL, modelPath);
    console.log("Saved", modelPath);
  } else {
    console.log("Model already present:", modelPath);
  }

  // Refresh wasm from the installed package.
  const wasmSrc = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  const wasmDst = path.join(root, "vendor", "wasm");
  if (fs.existsSync(wasmSrc)) {
    fs.mkdirSync(wasmDst, { recursive: true });
    for (const f of fs.readdirSync(wasmSrc))
      fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDst, f));
    const bundle = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "vision_bundle.mjs");
    fs.mkdirSync(path.join(root, "vendor", "tasks-vision"), { recursive: true });
    fs.copyFileSync(bundle, path.join(root, "vendor", "tasks-vision", "vision_bundle.mjs"));
    console.log("Refreshed wasm + bundle into vendor/");
  }
})();
