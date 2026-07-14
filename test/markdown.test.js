/**
 * Integration tests for Markdown-for-Agents content negotiation.
 *
 * These run the REAL Worker (src/index.js) in Miniflare. The static ASSETS
 * binding is stubbed with a service function that returns HTML; this mirrors
 * production, where `run_worker_first` runs the Worker and it calls
 * `env.ASSETS.fetch(...)`. We assert the Worker converts HTML to Markdown when
 * (and only when) the client negotiates for it, and that HTML stays the default.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

const root = new URL("..", import.meta.url);
const realIndexHtml = readFileSync(new URL("public/index.html", root), "utf8");

// A small, deterministic page so conversion assertions don't depend on the
// real site copy. Exercises headings, emphasis, links, lists and blockquotes,
// plus chrome (script/style/ad) that must be dropped.
const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <title>Fixture Title</title>
    <meta name="description" content="A fixture page." />
    <meta property="og:image" content="https://example.com/img.png" />
    <style>.x{color:red}</style>
    <script>console.log("noise")</script>
  </head>
  <body>
    <div class="watcher">SURVEILLANCE</div>
    <aside aria-label="Advertisement"><ins class="adsbygoogle">ad</ins></aside>
    <main>
      <h1>Main Heading</h1>
      <p>A paragraph with <strong>bold</strong> and <em>italic</em> and a
        <a href="/next">relative link</a>.</p>
      <blockquote>Quoted wisdom.</blockquote>
      <ul><li>first</li><li>second</li></ul>
    </main>
  </body>
</html>`;

const PAGES = {
  "/": realIndexHtml,
  "/fixture": FIXTURE,
};

function makeWorker() {
  return new Miniflare({
    modules: true,
    scriptPath: new URL("src/index.js", root).pathname,
    compatibilityDate: "2026-07-06",
    d1Databases: { DB: "test-db" },
    serviceBindings: {
      ASSETS(request) {
        const p = new URL(request.url).pathname;
        const html = PAGES[p];
        if (html == null) {
          return new Response("not found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
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

const fetchPath = (path, { accept, method = "GET" } = {}) =>
  mf.dispatchFetch(`https://theskyisnotreal.com${path}`, {
    method,
    headers: accept ? { Accept: accept } : {},
  });

const varyList = (res) =>
  (res.headers.get("Vary") || "").split(",").map((s) => s.trim().toLowerCase());

// ------------------------------------------------------------- markdown branch

test("Accept: text/markdown → 200 text/markdown with token headers", async () => {
  const res = await fetchPath("/fixture", { accept: "text/markdown" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.ok(varyList(res).includes("accept"), "Vary must include Accept");

  const mdTokens = Number(res.headers.get("x-markdown-tokens"));
  const origTokens = Number(res.headers.get("x-original-tokens"));
  assert.ok(Number.isInteger(mdTokens) && mdTokens > 0, "x-markdown-tokens");
  assert.ok(Number.isInteger(origTokens) && origTokens > 0, "x-original-tokens");
});

test("markdown body: frontmatter + converted structure, no HTML residue", async () => {
  const res = await fetchPath("/fixture", { accept: "text/markdown" });
  const md = await res.text();

  assert.ok(md.startsWith("---\n"), "starts with YAML frontmatter");
  assert.match(md, /title: "Fixture Title"/);
  assert.match(md, /description: "A fixture page\."/);
  assert.match(md, /image: "https:\/\/example\.com\/img\.png"/);

  assert.match(md, /^# Main Heading$/m, "h1 → # heading");
  assert.match(md, /\*\*bold\*\*/, "strong → bold");
  assert.match(md, /\*italic\*/, "em → italic");
  assert.match(md, /> Quoted wisdom\./, "blockquote → >");
  assert.match(md, /- first/, "li → - item");
  assert.match(md, /- second/);

  // Relative links resolve against the request URL (absolute for agents).
  assert.match(md, /\[relative link\]\(https:\/\/theskyisnotreal\.com\/next\)/);

  // Chrome must be gone, and no raw tags / entities / sentinels may leak.
  assert.doesNotMatch(md, /SURVEILLANCE/, "watcher dropped");
  assert.doesNotMatch(md, /adsbygoogle|<ins/, "ad dropped");
  assert.doesNotMatch(md, /console\.log/, "script dropped");
  assert.doesNotMatch(md, /color:red/, "style dropped");
  assert.doesNotMatch(md, /<[a-z/!][^>]*>/i, "no leftover HTML tags");
  assert.doesNotMatch(md, /&(gt|lt|amp|quot|nbsp);/, "no undecoded entities");
  assert.ok(!md.includes("\uE000"), "no leftover sentinels");
});

test("real homepage converts cleanly (no tag/entity residue)", async () => {
  const res = await fetchPath("/", { accept: "text/markdown" });
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  const md = await res.text();
  assert.match(md, /title: "the sky is not real"/);
  assert.match(md, /## Six things they don't want you to notice/);
  assert.doesNotMatch(md, /<[a-z/!][^>]*>/i, "no leftover HTML tags");
  assert.doesNotMatch(md, /&(gt|lt|amp|quot|nbsp);/, "no undecoded entities");
});

test("HEAD + Accept: text/markdown → markdown content-type, empty body", async () => {
  const res = await fetchPath("/fixture", { accept: "text/markdown", method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await res.text(), "");
});

test("/s/ permalink honors markdown and keeps X-Robots-Tag noindex", async () => {
  const res = await fetchPath("/s/abc123", { accept: "text/markdown" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex");
  const md = await res.text();
  assert.match(md, /title: "the sky is not real"/);
});

// ---------------------------------------------------------------- html default

test("browser Accept → HTML unchanged, but Vary: Accept added", async () => {
  const res = await fetchPath("/fixture", {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.ok(varyList(res).includes("accept"), "Vary must include Accept for caches");
  assert.equal(await res.text(), FIXTURE);
});

test("no Accept header → HTML", async () => {
  const res = await fetchPath("/fixture");
  assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("markdown ranked below html (q-values) → HTML wins", async () => {
  const res = await fetchPath("/fixture", { accept: "text/markdown;q=0.5, text/html" });
  assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("markdown explicitly refused (q=0) → HTML", async () => {
  const res = await fetchPath("/fixture", { accept: "text/markdown;q=0, text/html" });
  assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
});

test("non-HTML asset (404 text/plain) is not converted", async () => {
  const res = await fetchPath("/missing.txt", { accept: "text/markdown" });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Content-Type"), "text/plain");
});
