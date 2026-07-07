// Regenerate brand/logo.png from brand/logo.svg.
//
// The logo MUST stay in sync with public/favicon.svg (same mark + colors) so the
// AdSense consent-banner logo doesn't drift from the site. If you change the
// favicon, mirror the change in logo.svg and re-run this script.
//
// Requires `sharp` (already present via the project's dependencies).
// Run from the repo root:  node brand/render-logo.js
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const svg = fs.readFileSync(path.join(dir, "logo.svg"));
const out = path.join(dir, "logo.png");

// 1500x300 = 5:1, the AdSense-recommended aspect ratio. Rendered at high density
// then downscaled for crisp edges. Comfortably under the 150 KB limit.
sharp(svg, { density: 220 })
  .resize(1500, 300, { fit: "contain", background: { r: 5, g: 6, b: 10, alpha: 1 } })
  .png({ compressionLevel: 9 })
  .toFile(out)
  .then((info) => {
    const kb = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`brand/logo.png written — ${info.width}x${info.height}, ${kb} KB`);
  })
  .catch((e) => { console.error("render failed:", e.message); process.exit(1); });
