import { test, expect } from "@playwright/test";

// CI smoke E2E: no model calls (CI never uses a real Gemini key). Covers the
// paths every user takes before the interview starts: health, auth gate,
// test sign-in, dashboard and onboarding.

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
});

test("API rejects signed-out callers", async ({ request }) => {
  const res = await request.get("/api/interviews/00000000-0000-4000-8000-000000000000");
  expect(res.status()).toBe(401);
});

test("signed-out dashboard visit redirects to sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await page.waitForURL("**/signin?callbackUrl=%2Fdashboard");
  await expect(page.getByRole("heading", { name: "Sign in to Vox" })).toBeVisible();
});

test("sign in, reach the dashboard and open interview setup", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`smoke-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "Set up your interview" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Backend Engineer" })).toBeVisible();
});
