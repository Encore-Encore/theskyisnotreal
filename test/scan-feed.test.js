/**
 * Integration tests for the scan-seed / public feed surfaces:
 *   - POST /api/scan (seed capture)
 *   - GET /api/stats (public scan counter)
 *   - GET /api/scans/recent (public "recently scanned" feed)
 *
 * These run the REAL Worker (src/index.js) inside Miniflare against an in-memory
 * D1 database, so they exercise the actual routing, validation, and SQL, not a
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

function postScan(mf, body) {
  const init = { method: "POST" };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return mf.dispatchFetch("http://localhost/api/scan", init);
}

async function insertScan(mf, { country = null, region = null, city = null, seed = null } = {}) {
  const db = await mf.getD1Database("DB");
  await db
    .prepare("INSERT INTO scans (country, region, city, seed) VALUES (?, ?, ?, ?)")
    .bind(country, region, city, seed)
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

// ------------------------------------------------------------- POST /api/scan

test("POST /api/scan with a valid seed → 204 and stores that seed", async () => {
  const res = await postScan(mf, { seed: "abc12" });
  assert.equal(res.status, 204);

  const db = await mf.getD1Database("DB");
  const row = await db.prepare("SELECT seed FROM scans").first();
  assert.equal(row.seed, "abc12");
});

test("POST /api/scan with no body → 204 and stores seed = NULL (fire-and-forget)", async () => {
  const res = await postScan(mf);
  assert.equal(res.status, 204);

  const db = await mf.getD1Database("DB");
  const row = await db.prepare("SELECT seed FROM scans").first();
  assert.equal(row.seed, null);
});

for (const [label, seed] of [
  ["contains spaces/punctuation", "BAD ID!"],
  ["too long (> 64 chars)", "a".repeat(65)],
]) {
  test(`POST /api/scan with invalid seed (${label}) → 204 and stores seed = NULL`, async () => {
    const res = await postScan(mf, { seed });
    assert.equal(res.status, 204);

    const db = await mf.getD1Database("DB");
    const row = await db.prepare("SELECT seed FROM scans").first();
    assert.equal(row.seed, null);
  });
}

// ---------------------------------------------------------------- /api/stats

test("GET /api/stats → 200 { scans: <count> } with public Cache-Control", async () => {
  await insertScan(mf, { seed: "abc12" });
  await insertScan(mf, { seed: null });
  await insertScan(mf, { seed: "hello" });

  const res = await mf.dispatchFetch("http://localhost/api/stats");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scans: 3 });

  const cc = res.headers.get("Cache-Control") || "";
  assert.ok(cc.includes("public"), `expected public Cache-Control, got: ${cc}`);
  assert.ok(!cc.includes("no-store"), `expected cacheable response, got: ${cc}`);
});

test("GET /api/stats → 200 { scans: 0 } when the table is empty", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/stats");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scans: 0 });
});

// ----------------------------------------------------------- /api/scans/recent

test("GET /api/scans/recent → 200 { scans: [] } when nothing is seeded", async () => {
  await insertScan(mf, { seed: null });

  const res = await mf.dispatchFetch("http://localhost/api/scans/recent");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { scans: [] });
});

test("GET /api/scans/recent → only seeded rows, newest first, verdict reproduced from seed", async () => {
  // Insert in order: unseeded row (excluded), then two seeded rows.
  await insertScan(mf, { country: "US", region: "CA", city: "Nowhere", seed: null });
  await insertScan(mf, { country: "US", region: "CA", city: "Fresno", seed: "abc12" });
  await insertScan(mf, { country: "GB", region: "England", city: "London", seed: "hello" });

  const res = await mf.dispatchFetch("http://localhost/api/scans/recent");
  assert.equal(res.status, 200);

  const cc = res.headers.get("Cache-Control") || "";
  assert.ok(cc.includes("public"), `expected public Cache-Control, got: ${cc}`);

  const { scans } = await res.json();
  assert.equal(scans.length, 2, "unseeded row must be excluded");

  // Newest first: "hello" was inserted last.
  assert.equal(scans[0].seed, "hello");
  assert.equal(scans[0].city, "London");
  assert.equal(scans[0].region, "England");
  assert.equal(scans[0].country, "GB");
  assert.equal(scans[0].confidence, "99.2");

  assert.equal(scans[1].seed, "abc12");
  assert.equal(scans[1].city, "Fresno");
  assert.equal(scans[1].confidence, "98.8");

  for (const s of scans) {
    for (const key of ["city", "region", "country", "verdict", "confidence", "seed", "at"]) {
      assert.ok(key in s, `missing key: ${key}`);
    }
  }
});

test("GET /api/scans/recent → capped at the last 5 seeded scans", async () => {
  for (let i = 0; i < 8; i++) {
    await insertScan(mf, { seed: `seed${i}` });
  }

  const res = await mf.dispatchFetch("http://localhost/api/scans/recent");
  assert.equal(res.status, 200);
  const { scans } = await res.json();
  assert.equal(scans.length, 5);

  // Newest first: the last-inserted seed comes first.
  assert.equal(scans[0].seed, "seed7");
  assert.equal(scans[4].seed, "seed3");
});
