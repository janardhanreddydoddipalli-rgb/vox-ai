import { describe, it, expect, beforeEach } from "vitest";
import { upsertUserByEmail } from "@/lib/db";
import { resetDb } from "./setup";

beforeEach(async () => {
  await resetDb();
});

describe("upsertUserByEmail", () => {
  it("keeps the stored name and picture when a caller passes only the email", async () => {
    const first = await upsertUserByEmail("a@example.com", "Ada", "https://img/a.png");
    const again = await upsertUserByEmail("a@example.com");
    expect(again!.id).toBe(first!.id);
    expect(again!.name).toBe("Ada");
    expect(again!.image).toBe("https://img/a.png");
  });

  it("updates name and picture when new ones are passed", async () => {
    await upsertUserByEmail("a@example.com", "Ada", "https://img/a.png");
    const updated = await upsertUserByEmail("a@example.com", "Ada L.", "https://img/b.png");
    expect(updated!.name).toBe("Ada L.");
    expect(updated!.image).toBe("https://img/b.png");
  });
});
