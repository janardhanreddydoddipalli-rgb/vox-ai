import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { apiAs, signIn } from "./helpers";

// Interview lifecycle without model calls, through the UI (the browser calls
// services/api directly): start (no résumé) → end with no answers (the report
// needs no model) → report page → PDF download → dashboard → delete my data.
test("start, end, read the report, download the PDF, then delete my data", async ({ page }) => {
  const email = await signIn(page, "life");
  const a = await apiAs(page);

  await page.goto("/new");
  await page.getByRole("radio", { name: "Backend Engineer" }).click();
  await page.getByRole("radio", { name: /Senior/ }).click();
  await page.getByRole("button", { name: "Start interview" }).click();
  await page.waitForURL("**/interview/**");
  const interviewId = new URL(page.url()).pathname.split("/").at(-1)!;

  const info = await (await a.get(`/v1/interviews/${interviewId}`)).json();
  expect(info).toMatchObject({ id: interviewId, role: "Backend Engineer", level: "senior", status: "active", qa: [] });

  await page.getByRole("button", { name: "End interview" }).click();
  await page.waitForURL(`**/interviews/${interviewId}/report`);
  await expect(page.getByRole("heading", { name: "Interview report" })).toBeVisible();
  await expect(page.locator(".score-big")).toHaveText("0.0");
  await expect(page.getByText("No questions were answered in this interview.")).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`vox-interview-${interviewId.slice(0, 8)}.pdf`);
  expect((await readFile(await download.path())).subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");

  await page.goto("/dashboard");
  await expect(page.locator(".interview-row", { hasText: "Backend Engineer" })).toBeVisible();
  await expect(page.locator(".interview-row").getByRole("link", { name: "Report" })).toBeVisible();

  await page.getByRole("button", { name: "Delete my data" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page.getByRole("button", { name: "Delete my data" })).toBeDisabled();
  // The account is gone, and so is the session that named it.
  await expect.poll(async () => (await page.request.get("/api/token")).status()).toBe(401);

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    expect(await sql`select 1 from users where email = ${email}`).toHaveLength(0);
    expect(await sql`select 1 from interviews where id = ${interviewId}`).toHaveLength(0);
  } finally {
    await sql.end();
  }
});
