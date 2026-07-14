/**
 * Integration tests for the per-scan social card:
 *  - GET /s/<id>/og.png renders a deterministic PNG (workers-og), cached + immutable.
 *  - GET /s/<id> (HTML) rewrites the og/twitter meta to that scan's verdict and the
 *    per-scan image, while keeping noindex and the canonical at "/".
 *
 * Uses the real ASSETS directory binding so the Worker can read the homepage HTML
 * and the bundled fonts (public/fonts) the card renders with. Runs against the
 * wrangler bundle via test/harness.mjs (the Worker imports workers-og + WASM).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { WORKER_SCRIPT, MODULE_RULES, ensureBundle } from "./harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://theskyisnotreal.com";

function makeWorker() {
  ensureBundle();
  return new Miniflare({
    modules: true,
    scriptPath: WORKER_SCRIPT,
    modulesRules: MODULE_RULES,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    assets: {
      directory: `${root}public`,
      binding: "ASSETS",
      assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
  });
}

let mf;
before(() => {
  mf = makeWorker();
});
after(async () => {
  await mf.dispose();
});

const PNG_MAGIC = "89504e470d0a1a0a";

// ------------------------------------------------------------------ image route

test("GET /s/<id>/og.png → 200 immutable PNG", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/s/az7f2q/og.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.match(res.headers.get("Cache-Control") || "", /immutable/);
  assert.match(res.headers.get("Cache-Control") || "", /max-age=31536000/);

  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 1000, "PNG should be non-trivial");
  assert.equal(buf.subarray(0, 8).toString("hex"), PNG_MAGIC, "valid PNG signature");
});

test("same id renders byte-identical (deterministic + cacheable)", async () => {
  const a = Buffer.from(await (await mf.dispatchFetch(`${ORIGIN}/s/abc12/og.png`)).arrayBuffer());
  const b = Buffer.from(await (await mf.dispatchFetch(`${ORIGIN}/s/abc12/og.png`)).arrayBuffer());
  assert.ok(a.length > 1000);
  assert.ok(a.equals(b), "identical seed must yield identical bytes");
});

test("og.png bypasses markdown negotiation (no Vary/Link, PNG even for Accept: markdown)", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/s/az7f2q/og.png`, {
    headers: { Accept: "text/markdown" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.equal(res.headers.get("Vary"), null, "image must not carry Vary: Accept");
  assert.equal(res.headers.get("Link"), null, "image must not carry the agent Link header");
});

// ------------------------------------------------------------------- meta rewrite

test("GET /s/<id> HTML rewrites og/twitter meta to the scan verdict + card", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/s/az7f2q`, {
    headers: { Accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/html/);
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");

  const html = await res.text();
  const content = (attr, val) =>
    new RegExp(`<meta [^>]*${attr}="${val}"[^>]*content="([^"]*)"`).exec(html)?.[1] ??
    new RegExp(`<meta [^>]*content="([^"]*)"[^>]*${attr}="${val}"`).exec(html)?.[1];

  // Image points at the per-scan card, as PNG.
  assert.equal(content("property", "og:image"), `${ORIGIN}/s/az7f2q/og.png`);
  assert.equal(content("name", "twitter:image"), `${ORIGIN}/s/az7f2q/og.png`);
  assert.equal(content("property", "og:image:type"), "image/png");

  // Title + description reflect the reproduced verdict (frozen for seed az7f2q).
  assert.equal(content("property", "og:title"), "Verdict: FAKE, 99.4% synthetic");
  assert.equal(content("name", "twitter:title"), "Verdict: FAKE, 99.4% synthetic");
  assert.match(content("property", "og:description") || "", /Off-the-shelf weather asset pack/);
  assert.match(content("name", "twitter:description") || "", /clouds are just buffering/);

  // og:url points at the specific scan; canonical stays at "/" (noindex variants).
  assert.equal(content("property", "og:url"), `${ORIGIN}/s/az7f2q`);
  assert.match(html, /<link rel="canonical" href="https:\/\/theskyisnotreal\.com\/" \/>/);
});

test("homepage / keeps its default (un-rewritten) social meta", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/`, { headers: { Accept: "text/html" } });
  const html = await res.text();
  assert.match(html, /og:image" content="https:\/\/theskyisnotreal\.com\/og-image\.jpg"/);
  assert.match(html, /og:title" content="the sky is not real"/);
  assert.doesNotMatch(html, /Verdict: FAKE/);
});
