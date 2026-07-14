import { test, expect } from "@playwright/test";

test("@smoke homepage renders the hero and the scan control", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle(/sky/i);
  await expect(page.locator(".hero__title")).toContainText(/the sky/i);
  await expect(page.locator("#skyScan")).toBeVisible();
});
