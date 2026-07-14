import { test, expect } from "@playwright/test";

// The public "skies scanned" counter counts all scans, so it shows a number in
// prod too (safe to smoke). On a fresh local DB it reads 0, still visible.
test("@smoke the public scan counter shows a number", async ({ page }) => {
  await page.goto("/");
  const counter = page.locator("#skyCounter");
  await expect(counter).toBeVisible({ timeout: 10_000 });
  await expect(counter).toContainText(/skies scanned/i);
  await expect(page.locator("#skyCounterNum")).toHaveText(/^\d[\d,]*$/);
});

// Not @smoke: the feed only lists scans that carry a seed, which accumulate after
// this ships, so prod can be empty right after a deploy. Locally we seed one scan
// via the beacon, then confirm it renders.
test("the recently-scanned feed lists a scan once one exists", async ({ page }) => {
  const beacon = await page.request.post("/api/scan", { data: { seed: "e2efeed" } });
  expect(beacon.status()).toBe(204);

  await page.goto("/");
  const feed = page.locator("#skyFeed");
  await expect(feed).toBeVisible({ timeout: 10_000 });
  await expect(feed).toContainText(/recently scanned/i);

  const rows = page.locator("#skyFeedList li");
  await expect(rows.first()).toBeVisible();
  await expect(feed).toContainText("FAKE");
  // Each row links to that scan's shareable card.
  await expect(page.locator(".scanner__feed-link").first()).toHaveAttribute(
    "href",
    /^\/s\/[a-z0-9]+$/
  );
});
