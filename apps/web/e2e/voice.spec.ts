import { test, expect, type Page } from "@playwright/test";

// Live voice routes through the signed-in browser session. CI has no Gemini key,
// so no live session can start; with ROUTE_VOICE=fastapi it is services/api
// answering, where tool calls and usage need a server-issued session id that
// another user can't use.
const viaApi = process.env.ROUTE_VOICE !== "next";
const UNKNOWN_SESSION = "55555555-5555-4555-8555-555555555555";

async function signIn(page: Page, who: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`${who}-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");
}

test("voice: no key means no live session; tool calls and usage stay scoped to the user", async ({ page, browser }) => {
  await signIn(page, "voice-a");
  const created = await page.request.post("/api/interviews", { multipart: { role: "Backend Engineer", level: "mid" } });
  const { id } = await created.json();

  const live = await page.request.post("/api/voice/session", { data: { language: "en", interviewId: id } });
  expect(live.status()).toBe(503);
  expect(await live.json()).toEqual({ error: "Voice service is not configured" });
  expect((await page.request.post("/api/voice/session", { data: { language: "fr" } })).status()).toBe(400);

  if (viaApi) {
    const tool = { name: "get_question", args: { role: "Backend", level: "mid" }, callId: "fc-1" };
    expect((await page.request.post("/api/voice/tool", { data: tool })).status()).toBe(400);
    const unknown = await page.request.post("/api/voice/tool", { data: { ...tool, sessionId: UNKNOWN_SESSION } });
    expect([unknown.status(), await unknown.json()]).toEqual([404, { error: "Voice session not found" }]);
    const usage = await page.request.post("/api/voice/usage", {
      data: { sessionId: UNKNOWN_SESSION, promptTokens: 1, responseTokens: 1 },
    });
    expect(usage.status()).toBe(404);
  } else {
    const tool = await page.request.post("/api/voice/tool", {
      data: { name: "get_question", args: { role: "Backend", level: "mid" }, interviewId: id },
    });
    expect((await tool.json()).ok).toBe(true);
    const usage = await page.request.post("/api/voice/usage", { data: { interviewId: id, promptTokens: 10, responseTokens: 5 } });
    expect(await usage.json()).toMatchObject({ ok: true, budgetExceeded: false });
    const other = await browser.newPage();
    await signIn(other, "voice-b");
    const foreign = await other.request.post("/api/voice/tool", { data: { name: "end_interview", interviewId: id } });
    expect(foreign.status()).toBe(404);
    await other.close();
  }
});
