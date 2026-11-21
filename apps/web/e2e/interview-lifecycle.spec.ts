import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Interview lifecycle without model calls: start (no résumé) → end with no
// answers (report needs no model) → report page → PDF → dashboard → delete data.
// Runs with ROUTE_INTERVIEWS=next and =fastapi in CI.
test("start, end, read the report, download the PDF, then delete my data", async ({ page }) => {
  const email = `life-${Date.now()}@example.com`;
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/new");
  await page.getByRole("radio", { name: "Backend Engineer" }).click();
  await page.getByRole("radio", { name: /Senior/ }).click();
  await page.getByRole("button", { name: "Start interview" }).click();
  await page.waitForURL("**/interview/**");
  const interviewId = new URL(page.url()).pathname.split("/").at(-1)!;

  const info = await (await page.request.get(`/api/interviews/${interviewId}`)).json();
  expect(info).toMatchObject({ id: interviewId, role: "Backend Engineer", level: "senior", status: "active", questionCount: 0 });

  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL(`**/interviews/${interviewId}/report`);
  await expect(page.getByRole("heading", { name: "Interview report" })).toBeVisible();
  await expect(page.locator(".score-big")).toHaveText("0.0");
  await expect(page.getByText("No questions were answered in this interview.")).toBeVisible();

  const pdf = await page.request.get(`/api/interviews/${interviewId}/report.pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");

  await page.goto("/dashboard");
  await expect(page.locator(".interview-row", { hasText: "Backend Engineer" })).toBeVisible();
  await expect(page.locator(".interview-row").getByRole("link", { name: "Report" })).toBeVisible();

  await page.getByRole("button", { name: "Delete my data" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page.getByRole("button", { name: "Delete my data" })).toBeDisabled();

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
    expect(await sql`select 1 from interviews where id = ${interviewId}`).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
