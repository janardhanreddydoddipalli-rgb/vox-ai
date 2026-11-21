import { test, expect, type Page } from "@playwright/test";

// Interview-mode turns through the signed-in browser session. CI has no model,
// so a turn ends with the documented error event after meta; with
// ROUTE_AGENT=fastapi it is services/api answering. Another user's interview
// id must never reach the agent.
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

async function signIn(page: Page, who: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`${who}-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");
}

test("interview turns: meta then error without a model; foreign interviews are not found", async ({ page, browser }) => {
  await signIn(page, "agent-a");
  const created = await page.request.post("/api/interviews", { multipart: { role: "Backend Engineer", level: "mid" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  const turn = await page.request.post("/api/chat", { data: { userText: "Ready", interviewId: id, history: [] } });
  const events = parseSse(await turn.text());
  expect(events[0].event).toBe("meta");
  expect(events[0].data).toMatchObject({ engine: "gemini", mode: "interview", interview_id: id });
  expect(events.at(-1)).toEqual({ event: "error", data: { message: "The interviewer hit a problem. Please try again." } });

  const other = await browser.newPage();
  await signIn(other, "agent-b");
  const foreign = parseSse(await (await other.request.post("/api/chat", { data: { userText: "hi", interviewId: id } })).text());
  expect(foreign[0].data).toEqual({ engine: "offline", reason: "Interview not found" });
  await other.close();
});
