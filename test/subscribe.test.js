/**
 * Integration tests for POST /api/subscribe.
 *
 * These run the REAL Worker (src/index.js) inside Miniflare against an in-memory
 * D1 database, so they exercise the actual routing, validation, and SQL — not a
 * reimplementation. Run with: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const root = fileURLToPath(new URL("..", import.meta.url));

// The CREATE TABLE from schema.sql, with `--` comment lines stripped, so the
// test's table definition stays the single source of truth (schema.sql).
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Build a Miniflare instance running the real Worker. When `withSchema` is
 * false the `subscribers` table is never created, so INSERT throws — that's how
 * we exercise handleSubscribe's 500 server_error path.
 */
async function makeWorker({ withSchema = true } = {}) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: `${root}src/index.js`,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
  });
  if (withSchema) {
    const db = await mf.getD1Database("DB");
    for (const stmt of SCHEMA) await db.prepare(stmt).run();
  }
  return mf;
}

function post(mf, body, { raw = false } = {}) {
  return mf.dispatchFetch("http://localhost/api/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
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
  await db.prepare("DELETE FROM subscribers").run();
});

// ---------------------------------------------------------------- happy path

test("valid email → 200 { ok: true } and is stored", async () => {
  const res = await post(mf, { email: "watcher@earth.dev" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const db = await mf.getD1Database("DB");
  const row = await db
    .prepare("SELECT email FROM subscribers WHERE email = ?")
    .bind("watcher@earth.dev")
    .first();
  assert.equal(row.email, "watcher@earth.dev");
});

test("duplicate email → still 200 and only one row (idempotent dedup)", async () => {
  await post(mf, { email: "dupe@earth.dev" });
  const res = await post(mf, { email: "dupe@earth.dev" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  const db = await mf.getD1Database("DB");
  const { count } = await db
    .prepare("SELECT COUNT(*) AS count FROM subscribers WHERE email = ?")
    .bind("dupe@earth.dev")
    .first();
  assert.equal(count, 1);
});

test("email is normalized (trimmed + lowercased) before storage", async () => {
  const res = await post(mf, { email: "  Foo@Bar.COM " });
  assert.equal(res.status, 200);

  const db = await mf.getD1Database("DB");
  const row = await db
    .prepare("SELECT email FROM subscribers")
    .first();
  assert.equal(row.email, "foo@bar.com");
});

// --------------------------------------------------------------- error cases

test("GET → 405 method_not_allowed with Allow: POST", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/subscribe", {
    method: "GET",
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("PUT → 405 method_not_allowed", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/subscribe", {
    method: "PUT",
  });
  assert.equal(res.status, 405);
  assert.deepEqual(await res.json(), { error: "method_not_allowed" });
});

test("malformed JSON body → 400 invalid_json", async () => {
  const res = await post(mf, "{not json", { raw: true });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_json" });
});

test("missing email field → 400 invalid_email", async () => {
  const res = await post(mf, {});
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_email" });
});

test("non-string email (number) → 400 invalid_email", async () => {
  const res = await post(mf, { email: 42 });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_email" });
});

// A matrix of shapes the liberal EMAIL_RE / length guard must reject.
for (const [label, email] of [
  ["empty string", ""],
  ["whitespace only", "   "],
  ["no @", "watcherearth.dev"],
  ["no dot in domain", "watcher@earthdev"],
  ["missing local part", "@earth.dev"],
  ["missing domain", "watcher@"],
  ["contains spaces", "a b@earth.dev"],
  ["too long (> 254)", `${"a".repeat(250)}@earth.dev`],
]) {
  test(`invalid email — ${label} → 400 invalid_email`, async () => {
    const res = await post(mf, { email });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_email" });

    const db = await mf.getD1Database("DB");
    const { count } = await db
      .prepare("SELECT COUNT(*) AS count FROM subscribers")
      .first();
    assert.equal(count, 0, "nothing should be stored for invalid input");
  });
}

test("D1 failure → 500 server_error", async () => {
  // No schema applied, so INSERT hits a missing table and throws.
  const broken = await makeWorker({ withSchema: false });
  try {
    const res = await post(broken, { email: "valid@earth.dev" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "server_error" });
  } finally {
    await broken.dispose();
  }
});

// --------------------------------------------------------- routing (bonus)

test("unknown /api/* path → 404 not_found", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/does-not-exist");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});

test("GET /api/geo → 200 JSON with geo fields, no-store", async () => {
  const res = await mf.dispatchFetch("http://localhost/api/geo");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  for (const key of ["city", "region", "country", "colo"]) {
    assert.ok(key in body, `missing key: ${key}`);
  }
});

test("www host → 301 redirect to apex, preserving path + query", async () => {
  const res = await mf.dispatchFetch(
    "https://www.theskyisnotreal.com/about?x=1",
    { redirect: "manual" }
  );
  assert.equal(res.status, 301);
  assert.equal(
    res.headers.get("Location"),
    "https://theskyisnotreal.com/about?x=1"
  );
});
