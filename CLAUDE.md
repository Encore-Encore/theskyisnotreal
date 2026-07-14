# CLAUDE.md

theskyisnotreal.com: a satirical "the sky is fake" conspiracy site. Plain HTML/CSS/JS
(no framework) in `public/`, fronted by a Cloudflare Worker (`src/index.js`) with a
D1 database. The Worker keeps its dependency surface deliberately tiny: the platform
primitives (HTMLRewriter, WebCrypto, D1 bindings) plus exactly one npm runtime
dependency, `workers-og`, used only to render the per-scan Open Graph image (Satori +
resvg WASM). Do not add further runtime dependencies without a strong reason. The joke
must stay unmistakably a joke.

## Commands

```bash
npm run dev                         # wrangler dev (build.js runs first automatically)
npm test                            # node:test + Miniflare, exercises the REAL Worker
node --test test/subscribe.test.js  # one test file
npm run e2e                         # Playwright user-story tests (starts its own wrangler dev)
npm run e2e:smoke                   # read-only @smoke subset; set BASE_URL for prod
npm run build                       # build.js: public/ -> dist/ with hashed /assets/
npm run deploy                      # manual deploy; normally unneeded (see Deploys)
```

## Hard rules

1. **No em dashes, ever, anywhere**: not in copy, code, comments, or docs. En dashes
   as sentence connectors are banned too. Hyphens and the middot `·` are fine.
   Rewrite with a comma, colon, semicolon, period, or parentheses. Before finishing
   any change, check the repo with the Grep tool or `rg -n '\x{2014}|\x{2013}'`
   (this file deliberately never spells the characters, so the check cannot flag
   itself).
2. **The satire stays unmistakable.** The trust pages (`about.html`,
   `disclaimer.html`, `privacy.html`, `public/llms.txt`) keep their explicit "this
   is satire, the sky is real" disclaimers; never weaken or delete them. Punch at
   the conspiracy format, never at real groups of people.
3. **Naming canon**: the on-page device is the **"Deception Detector"** (never "Sky
   Scanner"; trademark risk vs Skyscanner). The cabal is **"Big Sky"**. No
   surveillance framing: "Scanning the sky over <city>", never "We see you in
   <city>".
4. **PII discipline**: subscriber emails exist only in D1 and the Access-gated
   admin; never log, cache, or expose them. Scans store coarse edge geo
   (city/region/country) plus the scan seed, never IPs. The public scan counter
   (`/api/stats`) and recent-scans feed (`/api/scans/recent`) DO expose the total
   count and the last few scans' coarse city + reproduced verdict, a deliberate
   product choice kept to city-level, never IPs or emails. Do not widen what is
   exposed (finer geo, IPs, emails) without an equally deliberate decision, and keep
   the framing about scanned skies, not watched people (see rule 3).

## Subagents (use them)

- **copy-guardian**: run every user-facing copy change through it (public/*.html,
  scanner strings in `public/script.js`, meta/OG/title text, llms.txt, and the repo
  docs `README.md` / `brand/README.md`). When a change adds or alters a user-facing
  feature or the stack, update `README.md` (and this file) to match, then run
  copy-guardian. Docs go stale silently; this is the checkpoint that keeps them honest.
- **worker-reviewer**: review any `src/index.js` change before shipping (read-only).
- **miniflare-test-writer**: add or update tests whenever a route changes; it knows
  the harness.
- **page-consistency**: when a page is added, removed, or its head/footer nav
  changes, keep the discovery surfaces in sync (`sitemap.xml`, `llms.txt`, footer
  nav, per-page canonical/description/OG). Enforces the "Adding a page" checklist.
- **site-tester**: runs the browser-level user-story tests (the `test-site` skill /
  `npm run e2e`) and reports pass/fail per story. Invoke after a change is merged or
  deployed, or to verify the site works end to end.

## Architecture

- **`public/` is the source; `dist/` is generated. Never edit `dist/`.** `build.js`
  copies `public/` to `dist/`, content-hashes `styles.css` + `script.js` into
  `/assets/<name>.<hash>.<ext>`, and rewrites HTML references. Wrangler runs it
  before dev and deploy.
- HTML must reference the bundles exactly as `"/styles.css"` and `"/script.js"`
  (quoted absolute paths); the build rewrites only those exact strings.
- **Routing order in `src/index.js` matters**: www->apex 301, /api/subscribe,
  /api/geo, /api/scan, /admin + /api/admin/stats (Access-gated), then a /api/* 404
  catch-all. New API endpoints go ABOVE the catch-all. After that: agent-card
  well-knowns, /a2a, /.well-known/api-catalog, `*.md` twins, the per-scan OG image
  `/s/<id>/og.png` (MUST precede the /s/ HTML branch, which would otherwise swallow
  it), /s/* permalinks, static assets.
- **Per-scan social cards**: a shared `/s/<id>` link unfurls as THAT scan's verdict.
  The verdict is reproduced from the id via `shared/scan-core.mjs` (`reproduce()`).
  `/s/<id>/og.png` renders a 1200x630 card with `workers-og` (fonts served from
  `public/fonts` via ASSETS, so no runtime Google Fonts fetch; result cached in the
  Cache API, immutable). The /s/ HTML branch runs an HTMLRewriter pass
  (`rewriteScanMeta`) to point `og:image`/`twitter:image` at that PNG and rewrite the
  title/description, while keeping `X-Robots-Tag: noindex` and the canonical at "/".
- **Every asset response funnels through `negotiateMarkdown()`** at the end of
  fetch: it sets `Vary: Accept`, the agent-discovery `Link` header on HTML, and
  cache headers (immutable for /assets/, a week for stable media). Because of
  `run_worker_first: true`, the Worker is the authoritative place for caching.
- **Agent/AEO surfaces**: `public/llms.txt`; Markdown twins of every page (forced
  via `/<page>.md`, or `Accept: text/markdown` on the HTML path); the A2A agent
  card (`/.well-known/agent-card.json`, legacy `agent.json`) with its JSON-RPC
  endpoint at `/a2a` (also advertised via a DNS-AID record, notes in
  `dns/dns-aid.md`); an RFC 9727 api-catalog. `htmlToMarkdown()` strips page chrome
  via the `drop` selector list in `src/index.js`; new decorative or interactive
  sections usually need adding there.
- **Admin fails closed**: without `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` it returns
  503. The Worker verifies the Access JWT itself even though Cloudflare's edge also
  gates the route; keep that defense-in-depth. (Both vars are committed in
  `wrangler.jsonc`; they are not secrets.)
- **/s/<id> is stateless**: the id is a seed the client uses to reproduce a scan.
  Served as the homepage with `X-Robots-Tag: noindex`; reproduced scans never
  beacon to /api/scan.

## Adding a page

1. `public/<page>.html` with canonical, meta description, and OG tags; reference
   `"/styles.css"` and `"/script.js"` exactly as written here.
2. Update footer nav on sibling pages, `public/sitemap.xml`, and `public/llms.txt`.
3. Verify the automatic Markdown twin (`/<page>.md`) reads sanely; extend the
   `drop` list if new chrome leaks in.
4. Copy goes through copy-guardian; if the Worker changed, add tests.

## Tests

Miniflare exercises the real Worker with in-memory D1; the schema is parsed out of
`schema.sql` at test time (single source of truth). The harness must mirror
production's `run_worker_first` via
`routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }`
or every /api/* route 404s.

Because the Worker now imports an npm package with WASM (`workers-og`), Miniflare
cannot load `src/index.js` directly. The suite runs against a wrangler-produced
bundle instead: `npm test` builds it first (`pretest` -> `npm run build:worker` ->
`.wrangler/test-build/`), and `test/harness.mjs` points Miniflare at that bundle with
a `CompiledWasm` module rule (and rebuilds it if you run a single test file directly).
Every test file imports `WORKER_SCRIPT` / `MODULE_RULES` / `ensureBundle` from that
harness. The per-scan verdict lives in `shared/scan-core.mjs` (imported by the Worker,
mirrored by `public/script.js`); `test/scan-core.test.js` guards that they stay in
sync.

Browser-level user stories are covered separately by Playwright (`e2e/`, run with
`npm run e2e`), which drives a real Chromium against a local `wrangler dev`: homepage,
run-a-scan, shared `/s/<id>` reproduce + OG image, trust pages, signup, admin gating,
404. `reducedMotion: reduce` keeps scans deterministic (instant, no fake-out). Tests
tagged `@smoke` are read-only (no D1 writes) and also run against production. CI:
`.github/workflows/e2e.yml` runs the full suite on PRs; `smoke.yml` runs the `@smoke`
subset against live theskyisnotreal.com after each push to main (post-deploy check);
`uptime.yml` is a lightweight curl probe of prod once a day (catches outages between
deploys, e.g. the account-wide Access deny; `workflow_dispatch` for an on-demand run). The `test-site` skill and
`site-tester` subagent run the E2E suite on demand.

## Deploys and data

- Every push to `main` auto-deploys via Cloudflare Workers Builds. GitHub CI runs
  the tests but does NOT gate the deploy. Never push unfinished work to `main`;
  branch and PR instead.
- D1 schema changes: `wrangler d1 execute theskyisnotreal-db --file=schema.sql`
  (add `--remote` for prod). Statements are `IF NOT EXISTS`.
- Local secrets go in `.dev.vars` (git-ignored; see `.dev.vars.example`). None are
  required today.
