import { test, expect } from "@playwright/test";

test("@smoke /admin is gated and never served publicly", async ({ request }) => {
  const res = await request.get("/admin", { maxRedirects: 0 });
  expect(res.status()).not.toBe(200);
  // Local: 401/403 (no Access JWT) or 503 (Access unconfigured). Prod: 302 to login.
  expect([301, 302, 401, 403, 503]).toContain(res.status());
});

test("@smoke an unknown path returns the 404 page", async ({ page }) => {
  const res = await page.goto("/definitely-not-a-real-page");
  expect(res?.status()).toBe(404);
});
