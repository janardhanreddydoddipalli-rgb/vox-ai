// Phase 7 cost guard: a per-user daily token budget. Before each agent turn
// we check today's usage; over budget the turn is refused with a friendly,
// spoken-style message. After each turn we add the measured tokens. No
// message content is stored here — just counts.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { tokenUsage } from "@/lib/db/schema";

export const DAILY_TOKEN_BUDGET = Number(process.env.DAILY_TOKEN_BUDGET ?? "200000");

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Total tokens used by this user today (UTC). 0 when the guard is disabled.
export async function tokensUsedToday(userId: string): Promise<number> {
  if (DAILY_TOKEN_BUDGET <= 0) return 0;
  const [row] = await db
    .select({ tokensIn: tokenUsage.tokensIn, tokensOut: tokenUsage.tokensOut })
    .from(tokenUsage)
    .where(and(eq(tokenUsage.userId, userId), eq(tokenUsage.day, todayUtc())))
    .limit(1);
  return row ? row.tokensIn + row.tokensOut : 0;
}

// Check before running a turn. Returns null when the turn may proceed, or a
// friendly spoken-style message when the user is over their daily budget.
export async function checkDailyBudget(userId: string): Promise<{ allowed: boolean; message: string | null; used: number; budget: number }> {
  if (DAILY_TOKEN_BUDGET <= 0) return { allowed: true, message: null, used: 0, budget: 0 };
  const used = await tokensUsedToday(userId);
  if (used < DAILY_TOKEN_BUDGET) return { allowed: true, message: null, used, budget: DAILY_TOKEN_BUDGET };
  return {
    allowed: false,
    used,
    budget: DAILY_TOKEN_BUDGET,
    message:
      "You've reached today's practice budget, so I'll pause here — this keeps Vox free to run. Your budget resets tomorrow at midnight UTC. Thanks for understanding!",
  };
}

// Record tokens consumed by a finished turn (idempotent upsert per user+day).
export async function recordTokenUsage(userId: string, tokensIn: number, tokensOut: number): Promise<void> {
  if (DAILY_TOKEN_BUDGET <= 0 || (tokensIn <= 0 && tokensOut <= 0)) return;
  await db
    .insert(tokenUsage)
    .values({ userId, day: todayUtc(), tokensIn, tokensOut })
    .onConflictDoUpdate({
      target: [tokenUsage.userId, tokenUsage.day],
      set: {
        tokensIn: sql`${tokenUsage.tokensIn} + ${tokensIn}`,
        tokensOut: sql`${tokenUsage.tokensOut} + ${tokensOut}`,
        updatedAt: new Date(),
      },
    });
}
