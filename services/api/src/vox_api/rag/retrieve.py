"""Hybrid retrieval over a user's document chunks: vector + full-text, fused with RRF.

Vector search finds paraphrases; full-text search finds exact terms (a framework,
a company, an acronym) that embeddings blur. Reciprocal rank fusion merges the two
rankings without having to calibrate their scores against each other.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.models import DocChunk

RRF_K = 60  # the usual constant: damps the weight of the very top ranks
CANDIDATES = 20  # taken from each ranking before fusing


@dataclass(frozen=True)
class Passage:
    id: uuid.UUID
    source: str
    text: str
    score: float


async def hybrid_search(
    db: AsyncSession,
    user_id: uuid.UUID,
    query: str,
    vector: list[float],
    embedding_model: str,
    *,
    limit: int = 5,
) -> list[Passage]:
    """The user's best passages for the query. Only the user's own chunks are read, and
    vectors are compared only with vectors from the same embedding model."""
    distance = DocChunk.embedding.cosine_distance(vector)
    by_vector = (
        select(DocChunk.id, func.row_number().over(order_by=distance).label("rank"))
        .where(DocChunk.user_id == user_id, DocChunk.embedding_model == embedding_model)
        .order_by(distance)
        .limit(CANDIDATES)
        .cte("by_vector")
    )
    tsquery = func.websearch_to_tsquery(literal_column("'simple'::regconfig"), query)
    text_rank = func.ts_rank_cd(DocChunk.tsv, tsquery)
    by_text = (
        select(DocChunk.id, func.row_number().over(order_by=text_rank.desc()).label("rank"))
        .where(DocChunk.user_id == user_id, DocChunk.tsv.op("@@")(tsquery))
        .order_by(text_rank.desc())
        .limit(CANDIDATES)
        .cte("by_text")
    )
    score = func.coalesce(1.0 / (RRF_K + by_vector.c.rank), 0.0) + func.coalesce(
        1.0 / (RRF_K + by_text.c.rank), 0.0
    )
    stmt = (
        select(DocChunk.id, DocChunk.source, DocChunk.text, score.label("score"))
        .outerjoin(by_vector, by_vector.c.id == DocChunk.id)
        .outerjoin(by_text, by_text.c.id == DocChunk.id)
        .where(DocChunk.user_id == user_id, or_(by_vector.c.id.is_not(None), by_text.c.id.is_not(None)))
        .order_by(score.desc(), DocChunk.id)
        .limit(limit)
    )
    rows = (await db.execute(stmt)).all()
    return [Passage(r.id, r.source, r.text, float(r.score)) for r in rows]
