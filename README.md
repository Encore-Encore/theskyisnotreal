# the sky is not real

A satirical landing page for **[theskyisnotreal.com](https://theskyisnotreal.com)** (live),
served from **Cloudflare Workers** (Static Assets). Design direction: *cosmic premium dark* —
deep-space gradient, animated starfield, glassmorphism cards, smooth scroll reveals.

## About — what is this?

It's a joke conspiracy site: a tongue-in-cheek manifesto arguing that the sky is a "carefully
crafted illusion." The original was a throwaway gag; this is the redesign — the absurd claim,
dressed up like a slick startup.

Highlights:

- **Cosmic-dark landing page** — animated `<canvas>` starfield, glowing headline
  ("Wake up. Look up. Doubt everything."), the manifesto in glassmorphism cards, and a
  tongue-in-cheek "evidence" stat strip.
- **"Scan the sky" detector** — a fake sky-integrity scan that always concludes *FAKE* with
  randomized confidence, diagnosis, and metrics (plus a rare ~2% "REAL?!" fake-out).
- **Shareable results** — each scan gets a short id at a clean path
  (`theskyisnotreal.com/s/<id>`). The id is a *seed* that deterministically reproduces the
  exact result, so a shared link shows the sharer's verdict. Fully stateless — no backend.
- **Fast & self-contained** — plain HTML/CSS/JS, no framework, no build step; respects
  `prefers-reduced-motion`; installable (web manifest + full icon set); SEO basics
  (sitemap, canonical, social share card).

*It's satire. The sky is, in fact, probably real. Please look up responsibly.*

## Stack

- Plain **HTML / CSS / JS** — no framework, no build step.
- Served by a minimal **Cloudflare Worker** (`src/index.js`) via the Static Assets binding
  (`run_worker_first: true`). The Worker handles the `www → apex` canonical redirect, serves
  the homepage for `/s/<id>` scan permalinks, and reserves `/api/*` for future dynamic bits.

## Project layout

```
public/                 # static site (served as-is)
  index.html
  styles.css
  script.js             # starfield, scroll reveals, count-up stats, sky scanner
  404.html              # on-brand custom 404
  favicon.svg           # crossed-out sky (cyan slash)
  favicon-16/32.png · apple-touch-icon.png · icon-192/512.png
  og-image.jpg          # 1200x630 social share card (+ og-image.svg source)
  site.webmanifest · robots.txt · sitemap.xml
src/index.js            # Worker: canonical redirect, /s/* permalinks, /api/*, ASSETS
wrangler.jsonc          # Cloudflare Workers config (assets + custom-domain routes)
```

## Develop

Requires Node.js 18+.

```bash
npm install        # installs wrangler
npm run dev        # local preview (wrangler dev)
```

## Deploy

Deployment is automated: this repo is connected to **Cloudflare Workers Builds**, so every
push to `main` builds and deploys. `theskyisnotreal.com` + `www` are attached as custom
domains (see the `routes` block in `wrangler.jsonc`).

Manual deploy, if ever needed:

```bash
npm run deploy     # = wrangler deploy
```

## Roadmap

- **Ads:** a reserved, hidden `.ad-slot` sits in the footer of `index.html`. Drop an AdSense
  (or house-ad) unit in there once the site is approved/live. (Needs a privacy policy +
  cookie consent first.)
- **Live counters / email capture:** the Worker's `/api/*` namespace is free for future
  dynamic bits — a live "skies scanned" counter, a newsletter signup, etc. (would use
  Cloudflare KV/D1).

---

*This is a joke website. The sky is, in fact, probably real.*
