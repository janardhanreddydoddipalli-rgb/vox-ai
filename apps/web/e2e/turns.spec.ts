import { test, expect } from "@playwright/test";

// Playground history, end to end through the signed-in browser session:
// save via /api/turns, read back, and confirm another user can't touch it.
// Runs with ROUTE_TURNS=next and =fastapi in CI. No model calls.
async function signIn(page: import("@playwright/test").Page, who: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`${who}-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");
}

test("save, read back, and keep history private", async ({ page, browser }) => {
  await signIn(page, "turns-a");
  const sessionId = `s-e2e-${Date.now().toString(36)}`;
  const turns = [
    { role: "user", text: "What is connection pooling?" },
    { role: "assistant", text: "Reusing open database connections.", latencyMs: 420 },
  ];

  const saved = await page.request.post("/api/turns", { data: { sessionId, mode: "browser", turns } });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).turns.map((t: { text: string }) => t.text)).toEqual(turns.map((t) => t.text));

  const one = await (await page.request.get(`/api/turns?sessionId=${sessionId}`)).json();
  expect(one.turns.map((t: { role: string; latencyMs: number | null }) => [t.role, t.latencyMs])).toEqual([
    ["user", null],
    ["assistant", 420],
  ]);
  const all = await (await page.request.get("/api/turns")).json();
  expect(all.sessions).toContain(sessionId);

  // A different user: can't read it, can't write into it.
  const other = await browser.newPage();
  await signIn(other, "turns-b");
  expect((await other.request.get(`/api/turns?sessionId=${sessionId}`)).status()).toBe(404);
  const injected = await other.request.post("/api/turns", {
    data: { sessionId, turns: [{ role: "user", text: "injected" }] },
  });
  expect(injected.status()).toBe(404);
  const after = await (await page.request.get(`/api/turns?sessionId=${sessionId}`)).json();
  expect(after.turns).toHaveLength(2);
  await other.close();
});
