/**
 * Integration tests for the A2A (Agent2Agent) surface.
 *
 * Runs the REAL Worker (src/index.js) in Miniflare. These routes are handled by
 * the Worker directly (no static assets), so the ASSETS binding is a harmless
 * stub. This is the real endpoint advertised via DNS-AID
 * (_a2a._agents.theskyisnotreal.com) and the well-known Agent Card.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";

const root = new URL("..", import.meta.url);

function makeWorker() {
  return new Miniflare({
    modules: true,
    scriptPath: new URL("src/index.js", root).pathname,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    serviceBindings: {
      ASSETS: () => new Response("not found", { status: 404 }),
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

const ORIGIN = "https://theskyisnotreal.com";
const rpc = (payload, { raw = false } = {}) =>
  mf.dispatchFetch(`${ORIGIN}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? payload : JSON.stringify(payload),
  });

// ------------------------------------------------------------------ agent card

for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
  test(`GET ${path} → 200 Agent Card`, async () => {
    const res = await mf.dispatchFetch(`${ORIGIN}${path}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") || "", /application\/json/);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

    const card = await res.json();
    assert.equal(card.name, "Deception Detector");
    assert.equal(card.url, `${ORIGIN}/a2a`, "url is absolute + points at /a2a");
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.ok(Array.isArray(card.skills) && card.skills.length > 0, "has skills");
    assert.equal(card.skills[0].id, "deception-scan");
    assert.ok(card.protocolVersion, "declares protocolVersion");
  });
}

// -------------------------------------------------------------- jsonrpc endpoint

test("message/send → agent message result", async () => {
  const res = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId: "m1",
        parts: [{ kind: "text", text: "Scan the sky over Denver" }],
      },
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  assert.equal(body.result.kind, "message");
  assert.equal(body.result.role, "agent");
  assert.ok(typeof body.result.messageId === "string" && body.result.messageId.length > 0);
  assert.equal(body.result.parts[0].kind, "text");
  assert.match(body.result.parts[0].text, /Denver/, "echoes the prompt");
  assert.match(body.result.parts[0].text, /satirical/i, "keeps the satire disclaimer");
});

test("message/send with no text still returns a verdict", async () => {
  const res = await rpc({
    jsonrpc: "2.0",
    id: "x",
    method: "message/send",
    params: { message: { role: "user", messageId: "m2", parts: [] } },
  });
  const body = await res.json();
  assert.equal(body.result.role, "agent");
  assert.match(body.result.parts[0].text, /the sky above you/);
});

test("unknown method → -32601", async () => {
  const body = await (await rpc({ jsonrpc: "2.0", id: 2, method: "nope/nope" })).json();
  assert.equal(body.error.code, -32601);
  assert.equal(body.id, 2);
});

test("tasks/get → -32001 (stateless)", async () => {
  const body = await (
    await rpc({ jsonrpc: "2.0", id: 3, method: "tasks/get", params: { id: "t1" } })
  ).json();
  assert.equal(body.error.code, -32001);
});

test("malformed JSON → -32700 parse error, id null", async () => {
  const body = await (await rpc("{not json", { raw: true })).json();
  assert.equal(body.error.code, -32700);
  assert.equal(body.id, null);
});

test("missing jsonrpc/method → -32600 invalid request", async () => {
  const body = await (await rpc({ id: 4, foo: "bar" })).json();
  assert.equal(body.error.code, -32600);
});

test("OPTIONS /a2a → 204 with CORS", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/a2a`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(res.headers.get("Access-Control-Allow-Methods") || "", /POST/);
});

test("GET /a2a → 405 with Allow", async () => {
  const res = await mf.dispatchFetch(`${ORIGIN}/a2a`, { method: "GET" });
  assert.equal(res.status, 405);
  assert.match(res.headers.get("Allow") || "", /POST/);
});
