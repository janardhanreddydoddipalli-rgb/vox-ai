"""Index a user's résumé or job description into doc_chunks (port of apps/web agent/doc-index.ts)."""

import re
import uuid

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from vox_api.llm.base import LLMProvider
from vox_api.models import DocChunk

CHUNK_CHARS = 900  # ~200 tokens, split on paragraphs then sentences
MAX_CHUNKS = 50
_SENTENCES = re.compile(r"[^.!?]+[.!?]+|\S[^.!?]*$")


def chunk_text(text: str) -> list[str]:
    clean = re.sub(r"\s+", " ", text).strip()
    if not clean:
        return []
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n+", text)]
    pieces = [p for p in paragraphs if p] or [clean]
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if len(piece) > CHUNK_CHARS:
            for sentence in _SENTENCES.findall(piece) or [piece]:
                if len(current) + len(sentence) > CHUNK_CHARS and current:
                    chunks.append(current.strip())
                    current = ""
                current += sentence + " "
        elif len(current) + len(piece) > CHUNK_CHARS and current:
            chunks.append(current.strip())
            current = piece
        else:
            current += (" " if current else "") + piece
    if current.strip():
        chunks.append(current.strip())
    return [c for c in chunks if len(c) > 20]


async def index_document(
    db: AsyncSession, llm: LLMProvider, user_id: uuid.UUID, source: str, text: str
) -> list[str]:
    """Replace the user's chunks for this source. Returns the indexed chunk texts (for metering)."""
    chunks = chunk_text(text)[:MAX_CHUNKS]
    if not chunks:
        return []
    vectors = await llm.embed(chunks, task="RETRIEVAL_DOCUMENT")
    await db.execute(delete(DocChunk).where(DocChunk.user_id == user_id, DocChunk.source == source))
    db.add_all(
        DocChunk(
            user_id=user_id,
            source=source,
            text=c,
            embedding=v,
            embedding_model=llm.embedding_model,
            embedding_dim=len(v),
        )
        for c, v in zip(chunks, vectors, strict=True)
    )
    await db.flush()
    return chunks
