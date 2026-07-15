<div align="center">

<img src="brand/logo.png" alt="the sky is not real" width="520" />

**[theskyisnotreal.com](https://theskyisnotreal.com)** · *Wake up. Look up. Doubt everything.*

</div>

A satirical landing page for **[theskyisnotreal.com](https://theskyisnotreal.com)** (live),
served from **Cloudflare Workers** (Static Assets). Design direction: *cosmic premium dark*.
Deep-space gradient, animated starfield, glassmorphism cards, smooth scroll reveals.

## About: what is this?

It's a joke conspiracy site: a tongue-in-cheek manifesto arguing that the sky is a "carefully
crafted illusion." The original was a throwaway gag; this is the redesign: the absurd claim,
dressed up like a slick startup.

Highlights:

- **Cosmic-dark landing page**: animated `<canvas>` starfield, glowing headline
  ("Wake up. Look up. Doubt everything."), the manifesto in glassmorphism cards, and a
  tongue-in-cheek "evidence" stat strip. Trust pages (about, disclaimer, privacy,
  contact) state the joke plainly.
- **Deception Detector**: a fake sky scan that always concludes *FAKE* with randomized
  confidence, diagnosis, and metrics (plus a rare ~2% "REAL?!" fake-out). `/api/geo`
  localizes it (the "scanning the sky over `<city>`" line) and zooms a little world map.
  A public "skies scanned" counter and a live feed of the last 5 scans (coarse city +
  verdict, each linking to its shareable card) sit alongside it.
- **Shareable results**: each scan gets a short id at a clean path
  (`theskyisnotreal.com/s/<id>`). The id is a *seed* that deterministically reproduces the
  exact result, so a shared link shows that scan's verdict. Opening one also shows
  where the scan was taken (its city and a map zoom), a small geo lookup by id, not the
  viewer's location. Each link also unfurls with its own rendered social card
  (`/s/<id>/og.png`, a 1200x630 PNG generated at the edge with `workers-og`) plus a
  per-scan title and description.
- **The Evidence Files** (`/evidence`): a hub linking two joke "exhibits", a bug tracker of
  sky "glitches" (`/evidence/glitches`) and a leaked Big Sky maintenance memo
  (`/evidence/memo`). Each item is debunked in place with the real science (Rayleigh
  scattering, cloud formation, orbital mechanics, and so on).
- **Join the revolution**: email signup stored in D1 (`POST /api/subscribe`, deduped), an
  anonymous scan beacon (`POST /api/scan`: coarse city-level geo, no IP), and a
  Cloudflare Access-gated `/admin` snapshot of both.
- **Fast & self-contained**: plain HTML/CSS/JS, no framework. The one build step
  (`build.js`) copies `public/` to `dist/` and content-hashes the CSS/JS into
  `dist/assets/` so they cache forever; wrangler runs it automatically before `dev` and
  `deploy`. Respects `prefers-reduced-motion`; installable (web manifest + full icon
  set); SEO basics (sitemap, canonical, social share card, `schema.org` JSON-LD
  structured data on every content page).
- **AEO-friendly**: touches for answer engines and AI crawlers: Content Signals in
  `robots.txt`, `llms.txt`, a Markdown twin of every page (append `.md`, or send
  `Accept: text/markdown`), an RFC 9727 API catalog, and a satirical A2A agent
  (well-known Agent Card + `/a2a` JSON-RPC endpoint).

*It's satire. The sky is, in fact, probably real. Please look up responsibly.*

## Stack

- Plain **HTML / CSS / JS**, no framework. The only build step is `build.js` (see the
  `build.command` hook in `wrangler.jsonc`), which fingerprints the bundles so the
  Worker can serve `/assets/*` with `Cache-Control: immutable`.
- A **Cloudflare Worker** (`src/index.js`) in front of the assets
  (`run_worker_first: true`). It handles the `www → apex` canonical redirect, serves the
  homepage for `/s/<id>` scan permalinks, sets the asset cache policy, and owns the
  dynamic bits: `POST /api/subscribe`, `/api/geo`, the `POST /api/scan` beacon, and the
  `/admin` + `/api/admin/stats` dashboard (gated by Cloudflare Access, with the JWT
  re-verified in the Worker so it fails closed). It also serves the agent surfaces
  (the Markdown twins, the A2A Agent Card + `/a2a` endpoint, and the API catalog) and
  renders the per-scan Open Graph cards (`/s/<id>/og.png`) with `workers-og`, the
  Worker's single runtime dependency (Satori + resvg WASM).
- **Cloudflare D1** stores subscribers and scans; the schema is `schema.sql`
  (apply with `wrangler d1 execute theskyisnotreal-db --file=schema.sql`, add
  `--remote` for production).

## Project layout

```
public/                 # static site source (build.js copies it into dist/)
  index.html
  styles.css
  script.js             # starfield, scroll reveals, count-up stats, Deception Detector
  about/disclaimer/privacy/contact.html   # trust pages
  evidence.html          # Evidence Files hub
  evidence/glitches.html # Exhibit A: joke bug tracker, debunked with real science
  evidence/memo.html     # Exhibit B: leaked Big Sky memo, annotated with real astronomy
  404.html              # on-brand custom 404
  llms.txt              # agent-facing index of the site + its Markdown twins
  world-land.json       # land outline for the detector's location map
  favicon.svg           # crossed-out sky (cyan slash)
  favicon-16/32.png · apple-touch-icon.png · icon-192/512.png
  fonts/                # Inter (woff) for the per-scan OG card render
  og-image.jpg          # static 1200x630 default card (per-scan cards render dynamically)
  site.webmanifest · robots.txt · sitemap.xml · ads.txt
src/index.js            # Worker: redirect, /s/*, /api/*, admin, agent surfaces, OG, ASSETS
shared/scan-core.mjs    # deterministic scan verdict, shared by the Worker + client
build.js                # copies public/ to dist/, content-hashes CSS/JS into /assets/
dist/                   # build output wrangler serves (generated, git-ignored)
schema.sql              # D1 schema: subscribers + scans
test/                   # Worker integration tests (node --test + Miniflare)
e2e/                    # Playwright browser user-story tests
.github/workflows/      # CI: tests, e2e, post-deploy smoke, daily uptime
wrangler.jsonc          # Workers config (assets, build hook, D1, Access, domains)
brand/                  # logo + social-card sources
dns/                    # DNS-AID agent-discovery record notes
```

## Develop

Requires Node.js 18+.

```bash
npm install        # installs wrangler + miniflare + playwright
npm run dev        # local preview (wrangler dev; runs build.js first)
npm test           # Worker/API integration tests (node --test + Miniflare)
npm run e2e        # browser user-story tests (Playwright; starts its own wrangler dev)
```

The first `npm run e2e` may need `npx playwright install chromium` once.

## Deploy

Deployment is automated: this repo is connected to **Cloudflare Workers Builds**, so every
push to `main` builds and deploys (GitHub tests, Cloudflare ships). GitHub Actions runs the
Worker/API tests and the Playwright E2E suite on every PR, a post-deploy `@smoke` check
against live production after each push to `main`, and a daily uptime probe.
`theskyisnotreal.com` + `www` are attached as custom domains (see the `routes` block in
`wrangler.jsonc`).

Manual deploy, if ever needed:

```bash
npm run deploy     # = wrangler deploy
```

## Roadmap

- **House ads / server-side ad config**: the Worker fronts every request, so ad rotation
  can move server-side without re-architecting.

## License

The code is [MIT](LICENSE). The jokes are not: the satirical copy, the logo and brand
assets (`brand/`, the og images, the favicons), and the rest of the site's creative
content are copyright Encore-Encore, all rights reserved. Fork the machinery; write
your own sky.

---

*This is a joke website. The sky is, in fact, probably real.*
