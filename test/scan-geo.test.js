/**
 * Integration tests for the /s/<id> original-location injection: when a shared
 * scan permalink has a recorded scan row (matched by seed), the Worker injects
 * `window.__SCAN_GEO__` into <head> so the client renders THAT scan's sky
 * instead of the viewer's. See rewriteScanMeta() / scanGeoBySeed() in
 * src/index.js.
 *
 * These run the REAL Worker (src/index.js) inside Miniflare against an in-memory
 * D1 database, so they exercise the actual routing and SQL, not a
 * reimplementation. Run with: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { WORKER_SCRIPT, MODULE_RULES, ensureBundle } from "./harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// The CREATE TABLE(s) from schema.sql, with `--` comment lines stripped, so the
// test's table definitions stay the single source of truth (schema.sql).
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

// Needs the real ASSETS directory binding (not a mocked service binding): the
// /s/ branch fetches the homepage HTML from ASSETS before rewriting its head.
async function makeWorker() {
  ensureBundle();
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_SCRIPT,
    modulesRules: MODULE_RULES,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    assets: {
      directory: `${root}public`,
      binding: "ASSETS",
      assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
      // Mirror wrangler.jsonc `run_worker_first: true` so the Worker runs ahead of
      // the asset router (matches production; without this the router 404s /api/*).
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
  });
  const db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
  return mf;
}

async function insertScan(
  mf,
  { country = null, region = null, city = null, seed = null, latitude = null, longitude = null } = {}
) {
  const db = await mf.getD1Database("DB");
  await db
    .prepare(
      "INSERT INTO scans (country, region, city, seed, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(country, region, city, seed, latitude, longitude)
    .run();
}

let mf;
before(async () => {
  mf = await makeWorker();
});
after(async () => {
  await mf.dispose();
});
beforeEach(async () => {
  const db = await mf.getD1Database("DB");
  await db.prepare("DELETE FROM scans").run();
});

test("/s/<id> with a recorded scan → injects window.__SCAN_GEO__ with that scan's location", async () => {
  await insertScan(mf, {
    country: "GB",
    region: "England",
    city: "London",
    seed: "geotest",
    latitude: 51.5074,
    longitude: -0.1278,
  });

  const res = await mf.dispatchFetch("https://theskyisnotreal.com/s/geotest", {
    headers: { Accept: "text/html" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");

  const html = await res.text();
  assert.match(html, /window\.__SCAN_GEO__/);

  const match = html.match(/window\.__SCAN_GEO__=(\{.*?\});<\/script>/);
  assert.ok(match, "expected an injected __SCAN_GEO__ script tag");
  const geo = JSON.parse(match[1]);
  assert.equal(geo.city, "London");
  assert.equal(geo.latitude, 51.5074);

  // Existing og:image rewrite still holds alongside the new geo injection.
  assert.match(html, /property="og:image"\s+content="[^"]*\/s\/geotest\/og\.png"/);
});

test("/s/<id> with no recorded scan → no __SCAN_GEO__ injected (client falls back to /api/geo)", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/s/nornd", {
    headers: { Accept: "text/html" },
  });
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(!html.includes("window.__SCAN_GEO__"));
});
