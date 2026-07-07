// Regenerate the brand PNGs from their SVG sources.
//
// The logos MUST stay in sync with public/favicon.svg (same mark + colors) so the
// AdSense consent-banner logo doesn't drift from the site. If you change the
// favicon, mirror the change in logo.svg / logo-light.svg and re-run this script.
//
// Requires `sharp` (already present via the project's dependencies).
// Run from the repo root:  node brand/render-logo.js
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const dir = __dirname;

// 1500x300 = 5:1, the AdSense-recommended aspect ratio. Rendered at high density
// then downscaled for crisp edges. Comfortably under the 150 KB limit.
const targets = [
  // Dark, self-contained (its own background) — for dark/unknown surfaces.
  { svg: "logo.svg", png: "logo.png", background: { r: 5, g: 6, b: 10, alpha: 1 } },
  // Transparent — for light surfaces like the AdSense consent banner.
  { svg: "logo-light.svg", png: "logo-light.png", background: { r: 0, g: 0, b: 0, alpha: 0 } },
];

(async () => {
  for (const t of targets) {
    const buf = fs.readFileSync(path.join(dir, t.svg));
    const out = path.join(dir, t.png);
    const info = await sharp(buf, { density: 220 })
      .resize(1500, 300, { fit: "contain", background: t.background })
      .png({ compressionLevel: 9 })
      .toFile(out);
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`brand/${t.png} written — ${info.width}x${info.height}, ${kb} KB`);
  }
})().catch((e) => { console.error("render failed:", e.message); process.exit(1); });
