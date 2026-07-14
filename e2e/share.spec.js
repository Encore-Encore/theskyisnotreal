import { test, expect } from "@playwright/test";

// A fixed seed reproduces a known verdict (see test/scan-core.test.js golden values).
const SEED = "az7f2q";

test("@smoke a shared /s/<id> link reproduces the scan verdict", async ({ page }) => {
  await page.goto(`/s/${SEED}`);
  await page.locator("#scan").scrollIntoViewIfNeeded();
  const verdict = page.locator("#skyVerdict");
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  await expect(verdict).toContainText("FAKE");
});

test("@smoke a shared /s/<id> unfurls with its own per-scan OG image", async ({ page, request }) => {
  await page.goto(`/s/${SEED}`);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    new RegExp(`/s/${SEED}/og\\.png$`)
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /FAKE/);

  const res = await request.get(`/s/${SEED}/og.png`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/png");
});
