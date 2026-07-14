/**
 * Deterministic scan verdict, shared by the Worker (per-scan OG image + social
 * meta) and mirrored by the client scanner in public/script.js.
 *
 * A /s/<id> permalink is stateless: the id is the seed. Both the browser and the
 * Worker must derive the SAME verdict from it, or the shared card would disagree
 * with the page. The pools and the LOCKED draw order below must stay byte-for-byte
 * in sync with public/script.js (guarded by test/scan-core.test.js). If you edit a
 * pool here, edit it there too, and vice versa.
 */

// Seeded pools. Order is significant: pick() is a single seeded draw, so appending
// to a pool only remaps that one dimension. Keep identical to public/script.js.
export const DIAGS = [
  "Elaborate hologram", "Painted ceiling", "Simulation layer 7", "Giant screensaver",
  "Recycled stock footage", "Low-res dome projection", "Green-screen backdrop",
  "Municipal projection dome", "Decommissioned planetarium", "AI-upscaled void",
  "Government-issued ceiling", "Unrendered skybox", "Placeholder texture (forgot to swap)",
  "Reused desktop wallpaper", "Lens flare, all the way down", "Off-the-shelf weather asset pack",
];
export const TEXES = ["240p", "potato", "480i", "16-bit", "blurry", "144p", "8-bit", "dial-up", "N64-era", "VHS", "compressed to oblivion"];
export const RECS = [
  "Advisory: do not make eye contact with the horizon.",
  "Next step: tell three people, trust none of them.",
  "Suggested response: act natural.",
  "Protocol: blink twice if you can read this.",
  "Guidance: the ceiling is load-bearing. Do not touch.",
  "Reminder: clouds are just buffering.",
  "Note: the warranty on reality has expired.",
  "Directive: question everything above eye level.",
  "Status: you were not supposed to see this.",
];

// Seeded PRNG (xmur3 hash seeding mulberry32). Identical to public/script.js.
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seedRng(seed) {
  return mulberry32(xmur3(seed)());
}

/**
 * Reproduce the settled scan result for a seed. The draw order is LOCKED and must
 * match finish() in public/script.js: fake-out roll, confidence, diagnosis,
 * render-artifacts, texture, recommendation.
 *
 * The settled on-page verdict is always "FAKE": the 2% fake-out only flashes
 * "REAL?!" then glitches back (and is skipped under reduced motion), so a static
 * card and the social meta always read "FAKE". `fakeoutRoll` is surfaced anyway in
 * case a caller wants the Easter egg.
 */
export function reproduce(seed) {
  const rng = seedRng(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const rand = (a, b) => Math.floor(a + rng() * (b - a + 1));

  const fakeoutRoll = rng() < 0.02;
  const conf = (97 + rng() * 2.9).toFixed(1);
  const diag = pick(DIAGS);
  const artifacts = rand(800, 2100).toLocaleString("en-US");
  const tex = pick(TEXES);
  const rec = pick(RECS);

  return { verdict: "FAKE", conf, diag, artifacts, tex, rec, fakeoutRoll };
}
