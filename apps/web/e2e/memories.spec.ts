import { test, expect } from "@playwright/test";
import postgres from "postgres";

// Settings → memories, end to end. Runs with ROUTE_MEMORIES=next (web DB) and
// =fastapi (services/api) in CI. No model calls: the memory row is seeded.
const zeroVector = `[${Array(768).fill(0).join(",")}]`;

test("list and delete a memory on the settings page", async ({ page }) => {
  const email = `mem-${Date.now()}@example.com`;
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Test sign-in" }).click();
  await page.waitForURL("**/dashboard");

  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const [user] = await sql`select id from users where email = ${email}`;
    await sql`insert into user_memories (user_id, kind, text, embedding)
              values (${user.id}, 'weakness', 'Struggles with SQL joins', ${zeroVector}::vector)`;
  } finally {
    await sql.end();
  }

  await page.goto("/settings");
  await expect(page.getByText("Struggles with SQL joins")).toBeVisible();
  await page.getByRole("button", { name: "Delete memory: Struggles with SQL joins" }).click();
  await expect(page.getByText("Struggles with SQL joins")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("No memories yet")).toBeVisible();
});
