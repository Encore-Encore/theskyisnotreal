# the sky is not real

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
- **Shareable results**: each scan gets a short id at a clean path
  (`theskyisnotreal.com/s/<id>`). The id is a *seed* that deterministically reproduces the
  exact result, so a shared link shows the sharer's verdict: no lookup, nothing stored.
- **Join the revolution**: email signup stored in D1 (`POST /api/subscribe`, deduped), an
  anonymous scan beacon (`POST /api/scan`: coarse city-level geo, no IP), and a
  Cloudflare Access-gated `/admin` snapshot of both.
- **Fast & self-contained**: plain HTML/CSS/JS, no framework. The one build step
  (`build.js`) copies `public/` to `dist/` and content-hashes the CSS/JS into
  `dist/assets/` so they cache forever; wrangler runs it automatically before `dev` and
  `deploy`. Respects `prefers-reduced-motion`; installable (web manifest + full icon
  set); SEO basics (sitemap, canonical, social share card).
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
  re-verified in the Worker so it fails closed). It also serves the agent surfaces:
  the Markdown twins, the A2A Agent Card + `/a2a` endpoint, and the API catalog.
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
  404.html              # on-brand custom 404
  llms.txt              # agent-facing index of the site + its Markdown twins
  world-land.json       # land outline for the detector's location map
  favicon.svg           # crossed-out sky (cyan slash)
  favicon-16/32.png · apple-touch-icon.png · icon-192/512.png
  og-image.jpg          # 1200x630 social share card (+ og-image.svg source)
  site.webmanifest · robots.txt · sitemap.xml · ads.txt
src/index.js            # Worker: redirect, /s/*, /api/*, admin, agent surfaces, ASSETS
build.js                # copies public/ to dist/, content-hashes CSS/JS into /assets/
dist/                   # build output wrangler serves (generated, git-ignored)
schema.sql              # D1 schema: subscribers + scans
test/                   # Worker integration tests (node --test + Miniflare)
wrangler.jsonc          # Workers config (assets, build hook, D1, Access, domains)
brand/                  # logo + social-card sources
dns/                    # DNS-AID agent-discovery record notes
```

## Develop

Requires Node.js 18+.

```bash
npm install        # installs wrangler + miniflare
npm run dev        # local preview (wrangler dev; runs build.js first)
npm test           # Worker/API integration tests (node --test + Miniflare)
```

## Deploy

Deployment is automated: this repo is connected to **Cloudflare Workers Builds**, so every
push to `main` builds and deploys, and GitHub Actions runs the test suite on every push
and PR (GitHub tests, Cloudflare ships). `theskyisnotreal.com` + `www` are attached as
custom domains (see the `routes` block in `wrangler.jsonc`).

Manual deploy, if ever needed:

```bash
npm run deploy     # = wrangler deploy
```

## Roadmap

- **Public counters**: the `scans` table already records every detection; surface a live
  "skies scanned" counter on the page (today those numbers are admin-only).
- **House ads / server-side ad config**: the Worker fronts every request, so ad rotation
  can move server-side without re-architecting.

---

*This is a joke website. The sky is, in fact, probably real.*
