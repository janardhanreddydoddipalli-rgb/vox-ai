"""Post-interview memory summarizer (port of apps/web agent/memory.ts).

Distills evaluations into 3-6 durable memories, embeds them, and skips any
that duplicate an existing memory or one earlier in the batch (cosine >= 0.9).
"""

import json
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.llm.base import LLMProvider, Message
from vox_api.models import InterviewQa, UserMemory
from vox_api.services.report import transcript

DEDUPE_THRESHOLD = 0.9
MIN_MEMORIES, MAX_MEMORIES = 3, 6
KINDS = ("strength", "weakness", "preference")
RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "memories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": list(KINDS)}, "text": {"type": "string"}},
                "required": ["kind", "text"],
            },
        }
    },
    "required": ["memories"],
}


@dataclass
class SummaryResult:
    created: int
    skipped: int
    tokens_in: int
    tokens_out: int
    embedded_texts: list[str]


def _dot(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))  # unit vectors: dot = cosine


async def summarize(
    db: AsyncSession, llm: LLMProvider, user_id: uuid.UUID, qa: list[InterviewQa]
) -> SummaryResult:
    if not qa:
        return SummaryResult(0, 0, 0, 0, [])
    prompt = (
        f"From this interview's evaluations, write {MIN_MEMORIES}-{MAX_MEMORIES} durable memories "
        "about the candidate that would help a future interviewer. Each memory is one short sentence "
        "(max 25 words) naming the specific topic. kind = 'weakness' for a knowledge or skill gap, "
        "'strength' for a clearly strong area, 'preference' for how the candidate likes to answer or "
        "work. Base every memory on the evaluations only.\n\n" + transcript(qa)
    )
    gen = await llm.generate([Message("user", prompt)], response_schema=RESPONSE_SCHEMA, temperature=0.3)
    proposed = json.loads(gen.text).get("memories") or []
    candidates = [
        (str(m["kind"]), str(m["text"]).strip())
        for m in proposed
        if isinstance(m, dict) and m.get("kind") in KINDS and str(m.get("text") or "").strip()
    ][:MAX_MEMORIES]
    if not candidates:
        return SummaryResult(0, 0, gen.tokens_in, gen.tokens_out, [])

    texts = [t for _, t in candidates]
    vectors = await llm.embed(texts, task="RETRIEVAL_DOCUMENT")
    kept: list[list[float]] = []
    created = skipped = 0
    for (kind, text), vec in zip(candidates, vectors, strict=True):
        nearest = await db.scalar(
            select(1 - UserMemory.embedding.cosine_distance(vec))
            .where(UserMemory.user_id == user_id, UserMemory.embedding_model == llm.embedding_model)
            .order_by(UserMemory.embedding.cosine_distance(vec))
            .limit(1)
        )
        if (nearest is not None and float(nearest) >= DEDUPE_THRESHOLD) or any(
            _dot(v, vec) >= DEDUPE_THRESHOLD for v in kept
        ):
            skipped += 1
            continue
        db.add(
            UserMemory(
                user_id=user_id,
                kind=kind,
                text=text,
                embedding=vec,
                embedding_model=llm.embedding_model,
                embedding_dim=len(vec),
            )
        )
        kept.append(vec)
        created += 1
    await db.flush()
    return SummaryResult(created, skipped, gen.tokens_in, gen.tokens_out, texts)
