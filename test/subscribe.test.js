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
    assets: {
      directory: `${root}public`,
      binding: "ASSETS",
      assetConfig: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
      // Mirror wrangler.jsonc `run_worker_first: true` so the Worker runs ahead of
      // the asset router (matches production; without this the router 404s /api/*).
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    },
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
  for (const key of ["city", "region", "country", "colo", "latitude", "longitude"]) {
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

// --------------------------------------------------------- markdown for agents

// UI chrome that must NOT leak into the Markdown rendering of the homepage.
const CHROME_NOISE = [
  "deception detector · v2.5",
  "awaiting scan",
  "Link copied",
  "Field Brief · 001",
  "Eyes Only",
  "Classified transmission",
];

test("Accept: text/markdown → clean Markdown with chrome stripped", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/", {
    headers: { Accept: "text/markdown" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/markdown/);
  const md = await res.text();

  // Real content survives.
  assert.match(md, /the field brief/i);
  assert.match(md, /So who is Big Sky\?/);

  // Decorative / interactive chrome is gone.
  for (const noise of CHROME_NOISE) {
    assert.ok(!md.includes(noise), `markdown should not contain chrome: ${noise}`);
  }

  // Evidence stats became a list, not one run-on line.
  assert.ok(
    !md.includes("real skies detected 100%"),
    "stats should not be mashed onto one line"
  );
  assert.match(md, /- .*real skies detected/);
});

test("browser Accept (text/html) still gets HTML, not Markdown", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/", {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/html/);
});

test("/index.md → Markdown even without an Accept header", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/index.md");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/markdown/);
  const md = await res.text();
  assert.match(md, /the field brief/i);
  for (const noise of CHROME_NOISE) {
    assert.ok(!md.includes(noise), `md twin should not contain chrome: ${noise}`);
  }
});

test("/about.md → Markdown of the About page", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/about.md");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /text\/markdown/);
});

test("/nonexistent.md → 404", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/nonexistent.md");
  assert.equal(res.status, 404);
});

test("/llms.txt → discovery file listing the .md twins", async () => {
  const res = await mf.dispatchFetch("https://theskyisnotreal.com/llms.txt");
  assert.equal(res.status, 200);
  const txt = await res.text();
  assert.match(txt, /the sky is not real/i);
  assert.match(txt, /\/index\.md/);
});
