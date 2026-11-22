"""RAG: ingestion records the embedding model per row; retrieval is hybrid (vector + full-text, RRF)."""

import random
import uuid
from typing import Any

from tests.helpers import fetch_one, insert_doc_chunk, insert_memory, insert_user
from vox_api.agent.loop import run_tool
from vox_api.agent.tools.base import ToolContext
from vox_api.llm.fake import FakeProvider
from vox_api.rag.ingest import index_document
from vox_api.rag.retrieve import RRF_K, hybrid_search

PASSAGES = [
    "Built a payments API in Go with PostgreSQL and Redis for a fintech startup.",
    "Led a mobile team shipping a React Native app to two million users.",
    "Migrated the platform to Kubernetes on GKE with Terraform and Argo CD.",
]


async def seed(database_url: str, user_id: uuid.UUID, texts: list[str], model: str | None = None) -> None:
    vectors = await FakeProvider().embed(texts, task="RETRIEVAL_DOCUMENT")
    for text, vec in zip(texts, vectors, strict=True):
        kwargs = {"embedding_model": model} if model else {}
        await insert_doc_chunk(database_url, user_id, text, vec, **kwargs)


async def search(app: Any, user_id: uuid.UUID, query: str) -> list[str]:
    llm = FakeProvider()
    [vec] = await llm.embed([query], task="RETRIEVAL_QUERY")
    async with app.state.session_factory() as db:
        return [p.text for p in await hybrid_search(db, user_id, query, vec, llm.embedding_model)]


async def test_ingestion_records_the_model_size_and_full_text_of_each_chunk(
    database_url: str, app: Any
) -> None:
    me = await insert_user(database_url)
    async with app.state.session_factory() as db:
        chunks = await index_document(
            db, FakeProvider(), me, "resume", "Python and Kubernetes engineer. " * 5
        )
        await db.commit()
    assert len(chunks) == 1
    row = await fetch_one(
        database_url,
        "select embedding_model, embedding_dim, tsv @@ to_tsquery('simple', 'kubernetes') as hit"
        " from doc_chunks where user_id = $1",
        me,
    )
    assert row == {"embedding_model": "fake-embedding-1", "embedding_dim": 768, "hit": True}


async def test_an_exact_term_ranks_its_passage_first(database_url: str, app: Any) -> None:
    me = await insert_user(database_url)
    await seed(database_url, me, PASSAGES)
    results = await search(app, me, "Kubernetes")
    assert results[0] == PASSAGES[2]  # in both rankings, so fusion puts it first
    assert sorted(results) == sorted(PASSAGES)  # the vector side still returns the rest


async def test_fused_scores_add_both_reciprocal_ranks(database_url: str, app: Any) -> None:
    me = await insert_user(database_url)
    await seed(database_url, me, PASSAGES)
    llm = FakeProvider()
    async with app.state.session_factory() as db:
        ctx = ToolContext(db=db, llm=llm, user_id=me, interview=None, rng=random.Random(0))
        out = await run_tool("search_documents", {"query": "Terraform"}, ctx)
    top, *rest = out["chunks"]
    assert top["text"] == PASSAGES[2]
    assert 1 / (RRF_K + 3) + 1 / (RRF_K + 1) <= top["score"] <= 2 / (RRF_K + 1)
    assert all(c["score"] <= 1 / (RRF_K + 1) for c in rest)  # vector rank only


async def test_retrieval_reads_only_the_users_own_chunks(database_url: str, app: Any) -> None:
    me = await insert_user(database_url)
    other = await insert_user(database_url)
    await seed(database_url, me, PASSAGES[:1])
    await seed(database_url, other, ["Kubernetes operator written by someone else entirely."])
    assert await search(app, me, "Kubernetes operator") == PASSAGES[:1]


async def test_vectors_from_another_embedding_model_are_never_compared(database_url: str, app: Any) -> None:
    me = await insert_user(database_url)
    await seed(database_url, me, PASSAGES[:1], model="old-embedding-model")
    assert await search(app, me, "fintech backend experience") == []  # no shared term, other model
    assert await search(app, me, "payments") == PASSAGES[:1]  # full-text doesn't depend on the model

    await insert_memory(
        database_url, me, "Struggles with system design", embedding_model="old-embedding-model"
    )
    async with app.state.session_factory() as db:
        ctx = ToolContext(db=db, llm=FakeProvider(), user_id=me, interview=None)
        assert await run_tool("recall_memories", {"query": "system design"}, ctx) == {"memories": []}
