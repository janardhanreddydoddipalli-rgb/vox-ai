import { test, expect, type Page } from "@playwright/test";

// Full E2E: test sign-in → onboarding → text-mode interview of 3 questions →
// scored report. Uses the real Gemini key from the environment (the agent
// loop is the product under test), so it is tagged @real-model and runs only
// in the manual evals workflow (npm run test:e2e:real-model), never in CI.
const ANSWERS = [
  "Between typing the URL and seeing the page, the browser resolves DNS, opens a TCP connection with TLS, sends the HTTP request, and the server responds with HTML. The browser parses the HTML into the DOM, fetches CSS and JS, builds the render tree, runs layout and paint, then composites the final frame.",
  "Connection pooling keeps a set of database connections open and reuses them for each request. Opening a connection costs a TCP and auth handshake per query, which is brutal in serverless where every invocation might be cold. A pool amortises that cost, and you size it to the database's max connections divided by instances.",
  "I would detect a cycle with two pointers: a slow pointer moving one step and a fast pointer moving two. If they ever meet there is a cycle; if fast reaches the end there is none. That uses O(1) memory instead of a hash set's O(n).",
];

async function sendAnswer(page: Page, text: string) {
  await page.getByLabel("Type your answer").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("sign up, run a 3-question text interview, and read the report @real-model", async ({ page }) => {
  test.setTimeout(600_000);

  // 1. Sign up with the test credentials provider.
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`e2e-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");

  // 2. Onboarding.
  await page.goto("/new");
  await expect(page.getByRole("heading", { name: "Set up your interview" })).toBeVisible();
  await page.getByRole("radio", { name: "Backend Engineer" }).click();
  await page.getByRole("radio", { name: /Senior/ }).click();
  await page.getByRole("button", { name: "Start interview" }).click();
  await page.waitForURL("**/interview/**");
  await expect(page.getByText("Current question")).toBeVisible();

  // 3. Three answered questions: wait for Vox's reply between each.
  for (let i = 0; i < 3; i++) {
    // Wait for the current question to be non-empty before answering.
    await expect(page.locator(".current-question p")).not.toHaveText("", { timeout: 120_000 });
    await expect(page.locator(".current-question p")).not.toHaveText("Vox is preparing your first question…", { timeout: 120_000 });
    const questionCountBefore = await page.locator(".turn-assistant").count();
    await sendAnswer(page, ANSWERS[i]);
    await expect(page.locator(".turn-assistant")).toHaveCount(questionCountBefore + 1, { timeout: 180_000 });
  }

  // 4. End the interview → report.
  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL("**/report", { timeout: 180_000 });
  await expect(page.getByRole("heading", { name: "Interview report" })).toBeVisible();
  await expect(page.locator(".score-big")).toBeVisible();
  await expect(page.getByText("Question by question")).toBeVisible();

  // 5. PDF download works.
  const pdf = await page.request.get(`/api/interviews/${interviewId(page)}/report.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
});

function interviewId(page: Page): string {
  const url = page.url();
  return url.split("/interviews/")[1]?.split("/")[0] ?? "";
}
