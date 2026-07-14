import { test, expect } from "@playwright/test";

const PAGES = [
  { path: "/about", needle: /satire|parody/i },
  { path: "/disclaimer", needle: /satire/i },
  { path: "/privacy", needle: /privacy/i },
  { path: "/contact", needle: /contact/i },
];

for (const { path, needle } of PAGES) {
  test(`@smoke ${path} loads and stays on-message`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("body")).toContainText(needle);
  });
}

test("@smoke the disclaimer keeps its explicit 'the sky is real' statement", async ({ page }) => {
  await page.goto("/disclaimer");
  await expect(page.locator("body")).toContainText(/the sky is real/i);
});
