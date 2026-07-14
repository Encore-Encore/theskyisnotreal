import { test, expect } from "@playwright/test";

// Not @smoke: the happy path writes a real row to D1, so it runs only against the
// local dev server, never production.
test("email signup shows the success confirmation", async ({ page }) => {
  await page.goto("/");
  await page.locator("#signup").scrollIntoViewIfNeeded();
  await page.locator("#signupEmail").fill(`e2e-${Date.now()}@earth.dev`);
  await page.locator("#signupBtn").click();

  const msg = page.locator("#signupMsg");
  await expect(msg).toContainText(/on the list|revolution/i, { timeout: 10_000 });
  await expect(msg).toHaveClass(/is-ok/);
});

test("signup rejects an obviously invalid email inline", async ({ page }) => {
  await page.goto("/");
  await page.locator("#signup").scrollIntoViewIfNeeded();
  await page.locator("#signupEmail").fill("not-an-email");
  await page.locator("#signupBtn").click();

  const msg = page.locator("#signupMsg");
  await expect(msg).toContainText(/valid email/i);
  await expect(msg).toHaveClass(/is-error/);
});
