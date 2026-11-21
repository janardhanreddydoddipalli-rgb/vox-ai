"""Per-user daily token budget across every paid model call (mirrors apps/web's cost guard)."""

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.repositories import usage as usage_repo

BUDGET_MESSAGE = (
    "You've reached today's practice budget, so I'll pause here — this keeps Vox free to run. "
    "Your budget resets tomorrow at midnight UTC. Thanks for understanding!"
)


@dataclass(frozen=True)
class Budget:
    allowed: bool
    used: int
    budget: int
    message: str | None = None


async def check(db: AsyncSession, user_id: uuid.UUID, daily_budget: int) -> Budget:
    if daily_budget <= 0:
        return Budget(True, 0, 0)
    used = await usage_repo.tokens_used_today(db, user_id)
    if used < daily_budget:
        return Budget(True, used, daily_budget)
    return Budget(False, used, daily_budget, BUDGET_MESSAGE)


async def record(
    db: AsyncSession, user_id: uuid.UUID, tokens_in: int, tokens_out: int, daily_budget: int
) -> None:
    if daily_budget <= 0 or (tokens_in <= 0 and tokens_out <= 0):
        return
    await usage_repo.add_usage(db, user_id, max(0, tokens_in), max(0, tokens_out))


def estimate_tokens(texts: list[str]) -> int:
    """Embeddings report no token counts; ~4 characters per token is Gemini's guidance."""
    return sum(max(1, len(t) // 4) for t in texts)
