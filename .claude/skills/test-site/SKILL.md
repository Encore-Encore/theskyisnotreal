---
name: test-site
description: Run the full end-to-end user-story tests for theskyisnotreal.com (Playwright in e2e/) and report which stories pass or fail. Use when asked to test the site, verify the site works end to end, or check the user stories, either locally against wrangler dev or against production.
---

# Test the site's user stories

Runs the Playwright suite in `e2e/` that walks a real browser through the site's user
stories: homepage renders, run a scan -> `FAKE` verdict + shareable `/s/<id>` link, a
shared link reproduces the verdict and shows its per-scan OG image, trust pages load
with their satire disclaimers, email signup succeeds, `/admin` is gated, and unknown
paths 404. This is the browser-level complement to the Miniflare API tests (`npm test`).

## How to run

Pick the target from the request:

- **Local (default, full suite):** the suite starts its own `wrangler dev` and seeds
  the local D1 schema. Covers the write flows (signup, scan beacon) too.
  ```bash
  npm run e2e
  ```
- **Against production (read-only `@smoke` subset, no D1 writes):**
  ```bash
  BASE_URL=https://theskyisnotreal.com npm run e2e:smoke
  ```
- **A single story:** `npx playwright test e2e/scan.spec.js` (or another spec).

If Playwright reports a missing browser, run `npx playwright install chromium` first.

## What to report

- A short pass/fail line per user story. Map specs to stories: `home`, `scan`,
  `share` (reproduce + OG image), `pages` (trust pages), `signup`, `misc`
  (admin-gated, 404).
- For any failure: the spec + assertion that failed, the broken user story in plain
  English, and the screenshot/trace under `playwright-report/` (open or attach it).
  Do not just paste raw Playwright output.
- If everything passes, say so plainly with the count and the target (local vs prod).

## Notes

- Deterministic by design: `reducedMotion: reduce` makes scans instant and settles the
  verdict to `FAKE` (no 2% "REAL?!" fake-out flake); `/s/<id>` seeds map to frozen
  verdicts guarded by `test/scan-core.test.js`.
- Never run the local full suite against production: signup and the scan beacon write
  to D1. Use the `@smoke` subset for prod.
