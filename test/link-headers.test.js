/**
 * Integration tests for RFC 8288 Link headers + the RFC 9727 API catalog.
 *
 * Runs the REAL Worker (src/index.js) in Miniflare. The ASSETS binding is
 * stubbed to serve HTML for the homepage (mirroring production, where
 * run_worker_first runs the Worker and it calls env.ASSETS.fetch).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { WORKER_SCRIPT, MODULE_RULES, ensureBundle } from "./harness.mjs";

const root = new URL("..", import.meta.url);
const ORIGIN = "https://theskyisnotreal.com";

const HTML = `<!doctype html><html><head><title>Home</title></head><body><h1>Hi</h1></body></html>`;

function makeWorker() {
  ensureBundle();
  return new Miniflare({
    modules: true,
    scriptPath: WORKER_SCRIPT,
    modulesRules: MODULE_RULES,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    serviceBindings: {
      ASSETS(request) {
        const p = new URL(request.url).pathname;
        if (p === "/" || p.endsWith(".html")) {
          return new Response(HTML, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (p === "/robots.txt") {
          return new Response("User-agent: *\n", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      },
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

const get = (path, headers = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, { headers });

// Parse a Link header into [{ target, rel, params }]
function parseLink(value) {
  if (!value) return [];
  // Split on commas that separate link-values (each starts with <...>)
  return value
    .split(/,\s*(?=<)/)
    .map((entry) => {
      const m = entry.match(/^\s*<([^>]*)>\s*(.*)$/);
      if (!m) return null;
      const params = {};
      m[2]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((p) => {
          const kv = p.match(/^([^=]+)="?([^"]*)"?$/);
          if (kv) params[kv[1].trim().toLowerCase()] = kv[2];
        });
      return { target: m[1], rel: params.rel, params };
    })
    .filter(Boolean);
}

// -------------------------------------------------------------- Link on homepage

test("homepage GET carries Link headers with registered rels", async () => {
  const res = await get("/");
  const links = parseLink(res.headers.get("Link"));
  const rels = links.map((l) => l.rel);
  assert.ok(rels.includes("api-catalog"), "advertises api-catalog");
  assert.ok(rels.includes("service-desc"), "advertises service-desc");

  const catalog = links.find((l) => l.rel === "api-catalog");
  assert.equal(catalog.target, "/.well-known/api-catalog");
  const desc = links.find((l) => l.rel === "service-desc");
  assert.equal(desc.target, "/.well-known/agent-card.json");
  assert.equal(desc.params.type, "application/json");
});

test("markdown variant of homepage also carries Link headers", async () => {
  const res = await get("/", { Accept: "text/markdown" });
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  const rels = parseLink(res.headers.get("Link")).map((l) => l.rel);
  assert.ok(rels.includes("api-catalog"));
  assert.ok(rels.includes("service-desc"));
});

test("non-HTML asset does NOT get Link headers", async () => {
  const res = await get("/robots.txt");
  assert.equal(res.headers.get("Content-Type"), "text/plain");
  assert.equal(res.headers.get("Link"), null, "Link only on HTML pages");
});

// ------------------------------------------------------------------ API catalog

test("GET /.well-known/api-catalog → RFC 9727 linkset", async () => {
  const res = await get("/.well-known/api-catalog");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/linkset+json");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

  const cat = await res.json();
  assert.ok(Array.isArray(cat.linkset) && cat.linkset.length > 0, "has a linkset");
  const entry = cat.linkset[0];
  assert.equal(entry.anchor, `${ORIGIN}/a2a`, "anchors the A2A API");
  assert.equal(entry["service-desc"][0].href, `${ORIGIN}/.well-known/agent-card.json`);
  assert.equal(entry["service-desc"][0].type, "application/json");
});

test("api-catalog Link target resolves to a real document", async () => {
  // The rel="api-catalog" href from the homepage must actually serve 200.
  const home = await get("/");
  const link = parseLink(home.headers.get("Link")).find((l) => l.rel === "api-catalog");
  const res = await get(link.target);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") || "", /linkset\+json/);
});

test("service-desc Link target resolves to the Agent Card", async () => {
  const home = await get("/");
  const link = parseLink(home.headers.get("Link")).find((l) => l.rel === "service-desc");
  const res = await get(link.target);
  assert.equal(res.status, 200);
  const card = await res.json();
  assert.equal(card.name, "Deception Detector");
});
