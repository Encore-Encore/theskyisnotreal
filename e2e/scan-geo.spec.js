import { test, expect } from "@playwright/test";

// A shared /s/<id> should show where the scan was TAKEN (its city + map zoom), not
// the viewer's location. global-setup seeds a London scan under the seed "e2elon";
// the Worker injects that scan's location so the client renders the London sky.
test("a shared /s/<id> shows the scan's original location, not the viewer's", async ({ page }) => {
  await page.goto("/s/e2elon");
  await page.locator("#scan").scrollIntoViewIfNeeded();

  await expect(page.locator("#skyVerdict")).toContainText("FAKE", { timeout: 15_000 });
  // The "scanning the sky over <city>" line reflects the scan's location (London),
  // server-injected via window.__SCAN_GEO__, not the machine running the test.
  await expect(page.locator("#skyGeo")).toContainText(/London/i);
});
