"""search_documents: passages from the candidate's own résumé and job description."""

from typing import Annotated, Any

from pydantic import BaseModel, StringConstraints
from sqlalchemy import select

from vox_api.agent.tools.base import Tool, ToolContext
from vox_api.models import DocChunk
from vox_api.services.cost_guard import estimate_tokens


class SearchIn(BaseModel):
    query: Annotated[str, StringConstraints(min_length=1, max_length=500)]


async def handler(args: SearchIn, ctx: ToolContext) -> dict[str, Any]:
    [vec] = await ctx.llm.embed([args.query], task="RETRIEVAL_QUERY")
    ctx.usage.tokens_in += estimate_tokens([args.query])
    distance = DocChunk.embedding.cosine_distance(vec)
    stmt = (
        select(DocChunk.id, DocChunk.source, DocChunk.text, (1 - distance).label("similarity"))
        .where(DocChunk.user_id == ctx.user_id)
        .order_by(distance)
        .limit(5)
    )
    rows = (await ctx.db.execute(stmt)).all()
    return {
        "chunks": [
            {"id": str(r.id), "source": r.source, "text": r.text, "similarity": float(r.similarity)}
            for r in rows
        ]
    }


TOOL = Tool(
    name="search_documents",
    description=(
        "Search the candidate's own uploaded documents (résumé and job description) for relevant "
        "passages. Use it to ground questions in the candidate's actual projects or the role's "
        "requirements. Returns the top 5 chunks."
    ),
    input_model=SearchIn,
    handler=handler,
)
