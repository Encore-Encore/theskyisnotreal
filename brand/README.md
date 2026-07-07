# Brand assets

Logos for theskyisnotreal.com. Used off-site (e.g. the **Google AdSense consent
banner**), so they live here in the repo rather than in `public/`.

## Files
A 5:1 horizontal lockup: the favicon mark (cloud struck through with a cyan
slash) + wordmark. Two variants:

- **`logo.svg` / `logo.png`** — **dark**, self-contained (its own dark cosmic
  background). Use on dark or unknown surfaces. 1500×300, ~73 KB.
- **`logo-light.svg` / `logo-light.png`** — **light**, transparent background
  with dark ink. **Use this on the AdSense consent banner** (white/light
  surface). 1500×300, ~25 KB.
- **`render-logo.js`** — regenerates both PNGs from the SVG sources.

## Keep it in sync with the favicon
This logo mirrors [`../public/favicon.svg`](../public/favicon.svg) — same mark,
same colors. **If you change the favicon, update `logo.svg` to match and
re-export**, so the AdSense banner never drifts from the site:

```sh
node brand/render-logo.js
```

## AdSense consent-banner logo requirements
- Format: **PNG or JPG**
- Size: **≤ 150 KB**
- Aspect ratio: **5:1 recommended**

Both PNGs satisfy all three. For the AdSense consent banner (a light surface),
upload **`logo-light.png`** in AdSense → **Privacy & messaging** → your consent
message → **Logo**.
