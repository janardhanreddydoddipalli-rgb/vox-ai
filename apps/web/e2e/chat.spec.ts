import { test, expect } from "@playwright/test";
import { apiAs, parseSse, signIn } from "./helpers";

// Plain voice chat over SSE from services/api. CI has no Gemini key, so the API
// answers from its offline fallback.
test("chat streams meta, sentences and done", async ({ page }) => {
  await signIn(page, "chat");
  const a = await apiAs(page);

  const res = await a.post("/v1/chat", { data: { user_text: "hello there", history: [] } });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/event-stream");

  const events = parseSse(await res.text());
  expect(events[0]).toEqual({ event: "meta", data: { engine: "offline", reason: "GEMINI_API_KEY not configured" } });
  expect(events.filter((e) => e.event === "sentence").map((e) => e.data.text)).toEqual([
    "Hello!",
    "I'm your voice assistant.",
    "What can I do for you?",
  ]);
  expect(events.at(-1)!.event).toBe("done");
});
