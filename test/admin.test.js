/**
 * Integration tests for the Access-gated admin scans explorer: /admin (HTML) and
 * /api/admin/stats (JSON), including the view/filter/pagination query contract
 * documented above getScanView() in src/index.js.
 *
 * These run the REAL Worker (src/index.js) inside Miniflare against an in-memory
 * D1 database, with a throwaway RSA keypair standing in for Cloudflare Access:
 * the JWKS is served through Miniflare's outboundService, and each test signs its
 * own RS256 JWT. test/analytics.test.js covers the fail-closed paths (no Access
 * config, no token, malformed token); this file covers the valid-token path and
 * the explorer's data contract. Run with: npm test
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, Response } from "miniflare";
import { WORKER_SCRIPT, MODULE_RULES, ensureBundle } from "./harness.mjs";
import { reproduce } from "../shared/scan-core.mjs";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-123";
const KID = "test-kid";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

async function signJwt(privateKey, kid, claims) {
  const headerB64 = b64url({ alg: "RS256", kid, typ: "JWT" });
  const payloadB64 = b64url(claims);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  return `${headerB64}.${payloadB64}.${Buffer.from(sig).toString("base64url")}`;
}

function validClaims(overrides = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return { iss: TEAM, aud: [AUD], iat, nbf: iat - 60, exp: iat + 3600, ...overrides };
}

function authHeaders(token) {
  return { "Cf-Access-Jwt-Assertion": token };
}

let mf;
let db;
let keypair;
let otherKeypair;
let jwk;

before(async () => {
  ensureBundle();

  const genKey = () =>
    crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
  keypair = await genKey();
  otherKeypair = await genKey();
  jwk = { ...(await crypto.subtle.exportKey("jwk", keypair.publicKey)), kid: KID, alg: "RS256", use: "sig" };

  mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_SCRIPT,
    modulesRules: MODULE_RULES,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    bindings: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
    outboundService: (req) =>
      req.url === `${TEAM}/cdn-cgi/access/certs`
        ? Response.json({ keys: [jwk] })
        : new Response("blocked", { status: 502 }),
  });
  db = await mf.getD1Database("DB");
  for (const stmt of SCHEMA) await db.prepare(stmt).run();
});

after(async () => {
  await mf.dispose();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM scans").run();
  await db.prepare("DELETE FROM subscribers").run();
});

async function insertScan(id, { created_at, country = null, region = null, city = null, seed = null }) {
  await db
    .prepare("INSERT INTO scans (id, created_at, country, region, city, seed) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, created_at, country, region, city, seed)
    .run();
}

async function getJson(path, token) {
  const res = await mf.dispatchFetch(`http://localhost${path}`, { headers: authHeaders(token) });
  return { res, body: await res.json() };
}

// ---------------------------------------------------------------- valid token

test("valid Access token -> 200 JSON with the expected shape", async () => {
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { res, body } = await getJson("/api/admin/stats", token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  assert.ok("subscribers" in body);
  assert.ok("scans" in body);
  assert.ok("recentSubscribers" in body);
  assert.ok("generatedAt" in body);
  assert.ok("explorer" in body);
});

test("valid Access token via CF_Authorization cookie -> 200", async () => {
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/admin", {
    headers: { Cookie: `CF_Authorization=${token}` },
  });
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------- default (recent) view

test("default view: recent, at most 20 rows, newest first, verdict matches reproduce()", async () => {
  for (let i = 1; i <= 25; i++) {
    await insertScan(i, {
      created_at: `2026-01-01 00:00:${String(i).padStart(2, "0")}`,
      country: "US",
      region: "Colorado",
      city: "Denver",
      seed: i === 25 ? null : `seed${i}`,
    });
  }
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats", token);

  assert.equal(body.explorer.view, "recent");
  assert.equal(body.explorer.rows.length, 20);
  // Row 0 is id 25 (newest), which has a NULL seed.
  assert.equal(body.explorer.rows[0].seed, null);
  assert.equal(body.explorer.rows[0].verdict, null);
  assert.equal(body.explorer.rows[0].confidence, null);
  // Row 1 is id 24, seeded.
  const expected = reproduce("seed24");
  assert.equal(body.explorer.rows[1].seed, "seed24");
  assert.equal(body.explorer.rows[1].verdict, expected.verdict);
  assert.equal(body.explorer.rows[1].confidence, expected.conf);
});

// ---------------------------------------------------------------- countries / cities views

test("?view=countries groups by country, ordered by count desc, NULL is its own group", async () => {
  let id = 1;
  const seedMany = async (country, n) => {
    for (let i = 0; i < n; i++) {
      await insertScan(id, { created_at: `2026-01-01 00:00:${String(id).padStart(2, "0")}`, country });
      id++;
    }
  };
  await seedMany("US", 5);
  await seedMany("GB", 3);
  await seedMany(null, 2);
  await seedMany("DE", 1);

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats?view=countries", token);

  assert.equal(body.explorer.view, "countries");
  assert.equal(body.explorer.total, 4);
  assert.deepEqual(
    body.explorer.rows.map((r) => r.country),
    ["US", "GB", null, "DE"]
  );
});

test("?view=cities groups by city+region+country: distinct regions stay separate, NULL city its own row", async () => {
  let id = 1;
  const add = async (country, region, city) => {
    await insertScan(id, { created_at: `2026-01-02 00:00:${String(id).padStart(2, "0")}`, country, region, city });
    id++;
  };
  await add("US", "Illinois", "Springfield");
  await add("US", "Missouri", "Springfield");
  await add("US", "Colorado", null);

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats?view=cities", token);

  assert.equal(body.explorer.view, "cities");
  assert.equal(body.explorer.total, 3);
  const rows = body.explorer.rows;
  assert.ok(rows.some((r) => r.city === "Springfield" && r.region === "Illinois"));
  assert.ok(rows.some((r) => r.city === "Springfield" && r.region === "Missouri"));
  assert.ok(rows.some((r) => r.city === null));
});

// ---------------------------------------------------------------- drill-downs

test("drill-down ?country=US returns only matching scans, newest first, and echoes the filter", async () => {
  await insertScan(1, { created_at: "2026-01-03 00:00:01", country: "US", city: "Denver", seed: "a1" });
  await insertScan(2, { created_at: "2026-01-03 00:00:02", country: "GB", city: "London", seed: "a2" });

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats?country=US", token);

  assert.equal(body.explorer.view, "scans");
  assert.deepEqual(body.explorer.filter, { country: "US" });
  assert.equal(body.explorer.rows.length, 1);
  assert.equal(body.explorer.rows[0].country, "US");
});

test("drill-down ?country= (empty) matches only NULL-country rows", async () => {
  await insertScan(1, { created_at: "2026-01-03 00:00:01", country: null, city: "Unknown" });
  await insertScan(2, { created_at: "2026-01-03 00:00:02", country: "US", city: "Denver" });

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats?country=", token);

  assert.deepEqual(body.explorer.filter, { country: null });
  assert.equal(body.explorer.rows.length, 1);
  assert.equal(body.explorer.rows[0].country, null);
});

test("drill-down ?country=US&region=Illinois&city=Springfield returns exactly that city", async () => {
  await insertScan(1, { created_at: "2026-01-04 00:00:01", country: "US", region: "Illinois", city: "Springfield" });
  await insertScan(2, { created_at: "2026-01-04 00:00:02", country: "US", region: "Missouri", city: "Springfield" });

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson(
    "/api/admin/stats?country=US&region=Illinois&city=Springfield",
    token
  );

  assert.equal(body.explorer.rows.length, 1);
  assert.equal(body.explorer.rows[0].region, "Illinois");
});

test("drill-down ?city=London (no region/country) matches Londons in every country", async () => {
  await insertScan(1, { created_at: "2026-01-05 00:00:01", country: "GB", region: "England", city: "London" });
  await insertScan(2, { created_at: "2026-01-05 00:00:02", country: "CA", region: "Ontario", city: "London" });
  await insertScan(3, { created_at: "2026-01-05 00:00:03", country: "US", city: "Denver" });

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const { body } = await getJson("/api/admin/stats?city=London", token);

  assert.deepEqual(body.explorer.filter, { city: "London" });
  assert.equal(body.explorer.rows.length, 2);
});

// ---------------------------------------------------------------- pagination

// created_at for scan id i in the 105-scan pagination fixture below. Exported as
// a plain function (not a helper import) so the "unique + covers everything"
// assertions can recompute the expected set independently of the insert loop.
function createdAtFor(i) {
  const minute = String(Math.floor(i / 60)).padStart(2, "0");
  const second = String(i % 60).padStart(2, "0");
  return `2026-02-01 00:${minute}:${second}`;
}

test("pagination: 105 scans in one country, page defaults and edge cases", async () => {
  for (let i = 1; i <= 105; i++) {
    await insertScan(i, { created_at: createdAtFor(i), country: "ZZ", city: "Zed City" });
  }
  // Sanity: the fixture's created_at values are all distinct (id order == time order).
  assert.equal(new Set(Array.from({ length: 105 }, (_, k) => createdAtFor(k + 1))).size, 105);

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const get = async (qs) => (await getJson(`/api/admin/stats?country=ZZ${qs}`, token)).body;

  const p1 = await get("");
  assert.equal(p1.explorer.rows.length, 100);
  assert.equal(p1.explorer.pages, 2);
  assert.equal(p1.explorer.page, 1);
  assert.equal(p1.explorer.total, 105);
  // Newest first: page 1's first row is scan id 105 (its created_at).
  assert.equal(p1.explorer.rows[0].at, createdAtFor(105));

  const p2 = await get("&page=2");
  assert.equal(p2.explorer.rows.length, 5);
  assert.equal(p2.explorer.page, 2);
  // Oldest last: page 2's last row is scan id 1.
  assert.equal(p2.explorer.rows.at(-1).at, createdAtFor(1));

  // Pages 1 + 2 together are a clean partition: no overlap, full coverage.
  const seenTimes = [...p1.explorer.rows, ...p2.explorer.rows].map((r) => r.at);
  const expectedTimes = new Set(Array.from({ length: 105 }, (_, k) => createdAtFor(k + 1)));
  assert.equal(new Set(seenTimes).size, 105);
  assert.deepEqual(new Set(seenTimes), expectedTimes);

  const pClamped = await get("&page=99");
  assert.equal(pClamped.explorer.page, 2);
  assert.equal(pClamped.explorer.rows.length, 5);

  const pNeg = await get("&page=-3");
  assert.equal(pNeg.explorer.page, 1);

  const pJunk = await get("&page=abc");
  assert.equal(pJunk.explorer.page, 1);
});

test("?view=cities pagination with ties: >100 groups sharing count and last, no overlap, full coverage", async () => {
  // 105 distinct cities, all with exactly one scan at the exact same timestamp, so
  // every group ties on count (n=1) and last (MAX(created_at)); ordering then falls
  // through to the country/region/city tie-breakers.
  const CITY_COUNT = 105;
  for (let i = 1; i <= CITY_COUNT; i++) {
    const city = `City${String(i).padStart(4, "0")}`;
    await insertScan(i, {
      created_at: "2026-05-01 00:00:00",
      country: "ZZ",
      region: "R",
      city,
    });
  }
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const p1 = (await getJson("/api/admin/stats?view=cities", token)).body;
  const p2 = (await getJson("/api/admin/stats?view=cities&page=2", token)).body;

  assert.equal(p1.explorer.total, CITY_COUNT);
  assert.equal(p1.explorer.rows.length, 100);
  assert.equal(p2.explorer.rows.length, 5);

  const citiesP1 = p1.explorer.rows.map((r) => r.city);
  const citiesP2 = p2.explorer.rows.map((r) => r.city);
  const overlap = citiesP1.filter((c) => citiesP2.includes(c));
  assert.deepEqual(overlap, []);

  const allSeen = new Set([...citiesP1, ...citiesP2]);
  const expected = new Set(
    Array.from({ length: CITY_COUNT }, (_, k) => `City${String(k + 1).padStart(4, "0")}`)
  );
  assert.equal(allSeen.size, CITY_COUNT);
  assert.deepEqual(allSeen, expected);
});

// ---------------------------------------------------------------- view fallback / filter precedence

test("?view=bogus falls back to recent; a filter overrides ?view=cities", async () => {
  await insertScan(1, { created_at: "2026-03-01 00:00:01", country: "US", city: "Denver" });

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const bogus = (await getJson("/api/admin/stats?view=bogus", token)).body;
  assert.equal(bogus.explorer.view, "recent");

  const combo = (await getJson("/api/admin/stats?view=cities&country=US", token)).body;
  assert.equal(combo.explorer.view, "scans");
  assert.deepEqual(combo.explorer.filter, { country: "US" });
});

// ---------------------------------------------------------------- PII guard

test("scan rows never leak latitude/longitude, even when the DB row has them", async () => {
  await insertScan(1, {
    created_at: "2026-06-01 00:00:01",
    country: "US",
    region: "Colorado",
    city: "Denver",
    seed: "pii1",
  });
  // insertScan's helper has no lat/long param, so bind them directly to prove the
  // explorer never surfaces them even when the underlying row carries them.
  await db
    .prepare("UPDATE scans SET latitude = ?, longitude = ? WHERE id = 1")
    .bind(39.74, -104.98)
    .run();

  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const SCAN_ROW_KEYS = ["at", "city", "region", "country", "seed", "verdict", "confidence"].sort();

  const recent = (await getJson("/api/admin/stats", token)).body;
  assert.equal(recent.explorer.rows.length, 1);
  assert.deepEqual(Object.keys(recent.explorer.rows[0]).sort(), SCAN_ROW_KEYS);

  const drilldown = (await getJson("/api/admin/stats?country=US", token)).body;
  assert.equal(drilldown.explorer.rows.length, 1);
  assert.deepEqual(Object.keys(drilldown.explorer.rows[0]).sort(), SCAN_ROW_KEYS);

  const countries = (await getJson("/api/admin/stats?view=countries", token)).body;
  for (const row of countries.explorer.rows) {
    assert.ok(!("latitude" in row));
    assert.ok(!("longitude" in row));
  }

  const cities = (await getJson("/api/admin/stats?view=cities", token)).body;
  for (const row of cities.explorer.rows) {
    assert.ok(!("latitude" in row));
    assert.ok(!("longitude" in row));
  }
});

// ---------------------------------------------------------------- HTML rendering

test("HTML /admin: default recent tab carries aria-current and its plain href", async () => {
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/admin", { headers: authHeaders(token) });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("Content-Type") || "").includes("text/html"));
  const html = await res.text();
  assert.match(html, /<a class="tab" href="\/admin#scans" aria-current="page">/);
});

test("HTML /admin?view=countries marks the countries tab current and links to a drill-down", async () => {
  await insertScan(1, { created_at: "2026-04-01 00:00:01", country: "US", city: "Denver" });
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/admin?view=countries", { headers: authHeaders(token) });
  const html = await res.text();
  assert.match(html, /<a class="tab" href="\/admin\?view=countries#scans" aria-current="page">/);
  assert.ok(html.includes('href="/admin?country=US#scans"'));
});

test("HTML escapes a city name with HTML-special characters and percent-encodes its drill-down href", async () => {
  await insertScan(1, {
    created_at: "2026-04-02 00:00:01",
    country: "US",
    region: "TX",
    city: "<b>x</b> & 'y'",
  });
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/admin?view=cities", { headers: authHeaders(token) });
  const html = await res.text();

  // No raw markup leaks from the data.
  assert.ok(!html.includes("<b>x</b>"));
  // The escaped text does appear.
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt; &amp; &#39;y&#39;"));
  // Its drill-down href is percent-encoded, then HTML-attribute-escaped.
  const qs = new URLSearchParams({ country: "US", region: "TX", city: "<b>x</b> & 'y'" }).toString();
  const expectedHref = `/admin?${qs}#scans`.replace(/&/g, "&amp;");
  assert.ok(html.includes(`href="${expectedHref}"`));
});

test("HTML drill-down with all-NULL filters paginates and escapes the pager href", async () => {
  // 105 scans with no geo at all, so ?country=&region=&city= matches every row.
  for (let i = 1; i <= 105; i++) {
    await insertScan(i, { created_at: `2026-07-01 00:00:${String(i % 60).padStart(2, "0")}` });
  }
  const token = await signJwt(keypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/admin?country=&region=&city=", {
    headers: authHeaders(token),
  });
  assert.equal(res.status, 200);
  const html = await res.text();

  // The pager's "next" link, HTML-attribute-escaped (raw & -> &amp;).
  assert.ok(html.includes('href="/admin?country=&amp;region=&amp;city=&amp;page=2#scans"'));
  // A filter that pins city/region keeps the cities tab lit.
  assert.match(html, /<a class="tab" href="\/admin\?view=cities#scans" aria-current="page">/);

  // Following that href (unescaped) through the JSON endpoint lands on page 2 with
  // the same NULL filter.
  const { body } = await getJson("/api/admin/stats?country=&region=&city=&page=2", token);
  assert.deepEqual(body.explorer.filter, { country: null, region: null, city: null });
  assert.equal(body.explorer.page, 2);
});

// ---------------------------------------------------------------- security (valid-token path)

test("wrong aud -> 403", async () => {
  const token = await signJwt(keypair.privateKey, KID, validClaims({ aud: ["someone-else"] }));
  const res = await mf.dispatchFetch("http://localhost/api/admin/stats", { headers: authHeaders(token) });
  assert.equal(res.status, 403);
});

test("expired token -> 403", async () => {
  const iat = Math.floor(Date.now() / 1000) - 7200;
  const token = await signJwt(keypair.privateKey, KID, { iss: TEAM, aud: [AUD], iat, nbf: iat, exp: iat + 10 });
  const res = await mf.dispatchFetch("http://localhost/api/admin/stats", { headers: authHeaders(token) });
  assert.equal(res.status, 403);
});

test("wrong iss -> 403", async () => {
  const token = await signJwt(keypair.privateKey, KID, validClaims({ iss: "https://impostor.cloudflareaccess.com" }));
  const res = await mf.dispatchFetch("http://localhost/api/admin/stats", { headers: authHeaders(token) });
  assert.equal(res.status, 403);
});

test("token signed by a different private key under the same kid -> 403", async () => {
  const token = await signJwt(otherKeypair.privateKey, KID, validClaims());
  const res = await mf.dispatchFetch("http://localhost/api/admin/stats", { headers: authHeaders(token) });
  assert.equal(res.status, 403);
});
