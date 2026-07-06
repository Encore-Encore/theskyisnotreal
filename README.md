# the sky is not real

A satirical landing page for [theskyisnotreal.com](https://theskyisnotreal.com), served
from **Cloudflare Workers** (Static Assets). Design direction: *cosmic premium dark* —
deep-space gradient, animated starfield, glassmorphism cards, smooth scroll reveals.

## Stack

- Plain **HTML / CSS / JS** — no framework, no build step.
- Served by a minimal **Cloudflare Worker** (`src/index.js`) via the Static Assets binding,
  so there's room to add dynamic endpoints later (the `/api/*` path is reserved).

## Project layout

```
public/           # static site (served as-is)
  index.html
  styles.css
  script.js       # starfield + scroll reveals + count-up stats
  favicon.svg
  og-image.svg
  robots.txt
src/index.js      # Worker: serves ASSETS, reserves /api/*
wrangler.jsonc    # Cloudflare Workers config
```

## Develop

Requires Node.js 18+.

```bash
npm install        # installs wrangler
npm run dev        # local preview at http://localhost:8787
```

## Deploy

```bash
npm run deploy     # = wrangler deploy
```

The first `wrangler deploy` prompts a Cloudflare login and ships to the
`theskyisnotreal.<subdomain>.workers.dev` preview URL.

### Custom domain

`theskyisnotreal.com` is on Cloudflare. To point it at this Worker, uncomment the `routes`
block in `wrangler.jsonc` (remove any conflicting DNS/CNAME record for the apex first), then
`npm run deploy`. Validate on the `*.workers.dev` URL before flipping the live domain.

### Auto-deploy from GitHub (optional)

Connect this repo to **Cloudflare Workers Builds** (dashboard → Workers → the Worker →
Settings → Builds) so every push to `main` redeploys.

## Roadmap

- **Ads:** a reserved, hidden `.ad-slot` sits in the footer of `index.html`. Drop an AdSense
  (or house-ad) unit in there once the site is approved/live.
- The Worker's `/api/*` namespace is free for future dynamic bits (e.g. a live "watchers
  online" counter).

---

*This is a joke website. The sky is, in fact, probably real.*
