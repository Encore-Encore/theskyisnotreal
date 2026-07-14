/**
 * Integration tests for the analytics features: the POST /api/scan beacon and
 * the Access-gated admin snapshot (/admin + /api/admin/stats).
 *
 * These run the REAL Worker (src/index.js) inside Miniflare against an in-memory
 * D1 database. The full "valid Access JWT" path needs a signed token + live JWKS,
 * so it isn't exercised here; instead we lock down the security-critical failure
 * modes (unconfigured → 503, no token → 401, bad token → 403), which is what
 * keeps subscriber PII from leaking. Run with: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { WORKER_SCRIPT, MODULE_RULES, ensureBundle } from "./harness.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

async function makeWorker(bindings = {}) {
  ensureBundle();
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_SCRIPT,
    modulesRules: MODULE_RULES,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    bindings,
  });
  const db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
  return mf;
}

// ---------------------------------------------------------------- /api/scan

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

test("POST /api/scan → 204 and records a scan row", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/scan", { method: "POST" });
  assert.equal(res.status, 204);

  const db = await mf.getD1Database("DB");
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM scans").first();
  assert.equal(n, 1);
});

test("GET /api/scan → 405 (POST only)", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/scan");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
});

// ---------------------------------------------------------------- admin gate

test("/admin with no Access config → 503 (fails closed)", async () => {
  const res = await mf.dispatchFetch("http://localhost/admin");
  assert.equal(res.status, 503);
});

test("/api/admin/stats with no Access config → 503 (fails closed)", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/admin/stats");
  assert.equal(res.status, 503);
});

test("/api/admin/stats configured but no token → 401", async () => {
  const gated = await makeWorker({
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUD: "aud-123",
  });
  const res = await gated.dispatchFetch("http://localhost/api/admin/stats");
  assert.equal(res.status, 401);
  await gated.dispose();
});

test("/admin configured with a malformed token → 403", async () => {
  const gated = await makeWorker({
    ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    ACCESS_AUD: "aud-123",
  });
  const res = await gated.dispatchFetch("http://localhost/admin", {
    headers: { "Cf-Access-Jwt-Assertion": "not.a.valid.jwt" },
  });
  assert.equal(res.status, 403);
  await gated.dispose();
});
