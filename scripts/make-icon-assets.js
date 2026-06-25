// Generates the Backbone app icon (build/icon.png, 1024x1024) with no external
// rasterizer — draws the slate squircle + vertebrae with anti-aliased SDF edges
// and encodes a PNG by hand. electron-builder converts this to .icns/.ico.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const N = 1024;
const buf = new Float32Array(N * N * 4); // straight RGBA, 0..1

function blend(px, py, r, g, b, cov) {
  if (cov <= 0) return;
  const i = (py * N + px) * 4;
  const da = buf[i + 3];
  const oa = cov + da * (1 - cov);
  if (oa <= 0) return;
  buf[i] = (r * cov + buf[i] * da * (1 - cov)) / oa;
  buf[i + 1] = (g * cov + buf[i + 1] * da * (1 - cov)) / oa;
  buf[i + 2] = (b * cov + buf[i + 2] * da * (1 - cov)) / oa;
  buf[i + 3] = oa;
}

// signed distance to a rounded rect; coverage via 1px smoothstep
function roundRect(hex, x, y, w, h, rr) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const cxr = x + w / 2, cyr = y + h / 2, hx = w / 2 - rr, hy = h / 2 - rr;
  const x0 = Math.max(0, Math.floor(x - 2)), x1 = Math.min(N - 1, Math.ceil(x + w + 2));
  const y0 = Math.max(0, Math.floor(y - 2)), y1 = Math.min(N - 1, Math.ceil(y + h + 2));
  for (let py = y0; py <= y1; py++)
    for (let px = x0; px <= x1; px++) {
      const qx = Math.abs(px + 0.5 - cxr) - hx;
      const qy = Math.abs(py + 0.5 - cyr) - hy;
      const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const sd = out + Math.min(Math.max(qx, qy), 0) - rr;
      const cov = Math.min(1, Math.max(0, 0.5 - sd));
      blend(px, py, r, g, b, cov);
    }
}

// background squircle (slate), with a transparent margin like a native icon
roundRect("#334155", 100, 100, 824, 824, 180);

// vertebrae: 5 discs, gentle S-curve, middle one coral
const cx = 512, w = 210, h = 82, rr = 40;
const rows = [
  { yc: 292, off: 0, color: "#ffffff" },
  { yc: 402, off: -20, color: "#ffffff" },
  { yc: 512, off: -28, color: "#FB7185" },
  { yc: 622, off: -8, color: "#ffffff" },
  { yc: 730, off: 20, color: "#ffffff" },
];
for (const r of rows) roundRect(r.color, cx + r.off - w / 2, r.yc - h / 2, w, h, rr);

// ---- encode PNG -----------------------------------------------------------
const rgba = Buffer.alloc(N * N * 4);
for (let i = 0; i < buf.length; i++) rgba[i] = Math.round(Math.min(1, Math.max(0, buf[i])) * 255);

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "build");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), png);
console.log("wrote build/icon.png", N + "x" + N, (png.length / 1024).toFixed(0) + "kb");
