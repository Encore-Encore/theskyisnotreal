import { test, expect } from "@playwright/test";

// Not @smoke: clicking scan fires the /api/scan beacon (a D1 write), so this runs
// only against the local dev server, never production.
test("running a scan returns a FAKE verdict and a shareable /s/ link", async ({ page }) => {
  await page.goto("/");
  await page.locator("#skyScan").scrollIntoViewIfNeeded();
  await page.locator("#skyScan").click();

  const verdict = page.locator("#skyVerdict");
  await expect(verdict).toBeVisible({ timeout: 15_000 });
  await expect(verdict).toContainText("FAKE");

  // The scan becomes a shareable seed permalink, and a share control is offered.
  await expect(page).toHaveURL(/\/s\/[a-z0-9]+$/i);
  await expect(page.locator("#skyShare")).toBeVisible();
});
