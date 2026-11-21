import { test, expect } from "@playwright/test";

// Plain voice chat over SSE through the signed-in browser session. CI has no
// Gemini key, so both apps answer from the offline fallback; with
// ROUTE_CHAT=fastapi the stream comes from services/api, passed through by Next.
function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const lines = b.split("\n");
      return {
        event: lines.find((l) => l.startsWith("event: "))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith("data: "))!.slice(6)),
      };
    });
}

test("chat streams meta, sentences and done", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`chat-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");

  const res = await page.request.post("/api/chat", { data: { userText: "hello there", history: [] } });
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
