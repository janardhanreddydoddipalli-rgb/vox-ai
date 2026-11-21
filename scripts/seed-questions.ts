// Seed the question bank from src/agent/questions-bank.ts. Idempotent:
// questions are unique on text, so re-running is a no-op.
import { db } from "@/lib/db";
import { questions } from "@/lib/db/schema";
import { QUESTION_BANK } from "@/agent/questions-bank";

async function main() {
  const inserted = await db.insert(questions).values(QUESTION_BANK).onConflictDoNothing().returning({ id: questions.id });
  console.log(`Seeded ${inserted.length} new questions (${QUESTION_BANK.length} total in bank).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
