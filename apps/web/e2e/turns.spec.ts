import { test, expect } from "@playwright/test";
import { apiAs, signIn } from "./helpers";

// Playground history on services/api as the signed-in user: save, read back,
// and confirm another user can't read or write it. No model calls.
test("save, read back, and keep history private", async ({ page, browser }) => {
  await signIn(page, "turns-a");
  const a = await apiAs(page);
  const sessionId = `s-e2e-${Date.now().toString(36)}`;
  const turns = [
    { role: "user", text: "What is connection pooling?" },
    { role: "assistant", text: "Reusing open database connections.", latency_ms: 420 },
  ];

  const saved = await a.post(`/v1/sessions/${sessionId}/turns`, { data: { mode: "browser", turns } });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).turns.map((t: { text: string }) => t.text)).toEqual(turns.map((t) => t.text));

  const one = await (await a.get(`/v1/sessions/${sessionId}/turns`)).json();
  expect(one.turns.map((t: { role: string; latency_ms: number | null }) => [t.role, t.latency_ms])).toEqual([
    ["user", null],
    ["assistant", 420],
  ]);
  expect((await (await a.get("/v1/turns")).json()).sessions).toContain(sessionId);

  const other = await browser.newPage();
  await signIn(other, "turns-b");
  const b = await apiAs(other);
  expect((await b.get(`/v1/sessions/${sessionId}/turns`)).status()).toBe(404);
  const injected = await b.post(`/v1/sessions/${sessionId}/turns`, { data: { turns: [{ role: "user", text: "injected" }] } });
  expect(injected.status()).toBe(404);
  expect((await (await a.get(`/v1/sessions/${sessionId}/turns`)).json()).turns).toHaveLength(2);
  await other.close();
});
