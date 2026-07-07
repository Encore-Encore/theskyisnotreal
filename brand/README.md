# Brand assets

Logos for theskyisnotreal.com. Used off-site (e.g. the **Google AdSense consent
banner**), so they live here in the repo rather than in `public/`.

## Files
- **`logo.svg`** — source of truth. A 5:1 horizontal lockup: the favicon mark
  (cloud struck through with a cyan slash) + the wordmark, on the brand's dark
  cosmic background.
- **`logo.png`** — rasterized export for upload. **1500×300 (5:1), ~35 KB.**
- **`render-logo.js`** — regenerates `logo.png` from `logo.svg`.

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

`logo.png` satisfies all three. Upload it in AdSense →
**Privacy & messaging** → your consent message → **Logo**.
