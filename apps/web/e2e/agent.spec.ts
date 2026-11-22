import { test, expect } from "@playwright/test";
import { apiAs, parseSse, signIn } from "./helpers";

// Interview-mode turns on services/api. CI has no model, so a turn ends with the
// documented error event after meta. Another user's interview id never reaches
// the agent.
test("interview turns: meta then error without a model; foreign interviews are not found", async ({ page, browser }) => {
  await signIn(page, "agent-a");
  const a = await apiAs(page);
  const created = await a.post("/v1/interviews", { multipart: { role: "Backend Engineer", level: "mid" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  const turn = await a.post(`/v1/interviews/${id}/turns`, { data: { user_text: "Ready", history: [] } });
  const events = parseSse(await turn.text());
  expect(events[0].event).toBe("meta");
  expect(events[0].data).toMatchObject({ engine: "gemini", mode: "interview", interview_id: id });
  expect(events.at(-1)).toEqual({ event: "error", data: { message: "The interviewer hit a problem. Please try again." } });

  const other = await browser.newPage();
  await signIn(other, "agent-b");
  const b = await apiAs(other);
  expect((await b.post(`/v1/interviews/${id}/turns`, { data: { user_text: "hi", history: [] } })).status()).toBe(404);
  await other.close();
});
