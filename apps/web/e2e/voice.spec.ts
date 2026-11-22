import { test, expect } from "@playwright/test";
import { apiAs, signIn } from "./helpers";

// Live voice on services/api. CI has no Gemini key, so no live session can start;
// tool calls and usage need a server-issued session id that is the caller's own.
const UNKNOWN_SESSION = "55555555-5555-4555-8555-555555555555";

test("voice: no key means no live session; tool calls and usage stay scoped to the user", async ({ page, browser }) => {
  await signIn(page, "voice-a");
  const a = await apiAs(page);
  const { id } = await (await a.post("/v1/interviews", { multipart: { role: "Backend Engineer", level: "mid" } })).json();

  const live = await a.post("/v1/voice/sessions", { data: { language: "en", interview_id: id } });
  expect(live.status()).toBe(503);
  expect((await live.json()).detail).toBe("Voice service is not configured");
  expect((await a.post("/v1/voice/sessions", { data: { language: "fr" } })).status()).toBe(422);

  const call = { call_id: "fc-1", name: "get_question", args: { role: "Backend", level: "mid" } };
  const unknown = await a.post(`/v1/voice/sessions/${UNKNOWN_SESSION}/tool-calls`, { data: call });
  expect([unknown.status(), (await unknown.json()).detail]).toEqual([404, "Voice session not found"]);
  const usage = await a.post(`/v1/voice/sessions/${UNKNOWN_SESSION}/usage`, { data: { prompt_tokens: 1, response_tokens: 1 } });
  expect(usage.status()).toBe(404);

  const other = await browser.newPage();
  await signIn(other, "voice-b");
  const b = await apiAs(other);
  expect((await b.post("/v1/voice/sessions", { data: { interview_id: id } })).status()).toBe(404);
  await other.close();
});
