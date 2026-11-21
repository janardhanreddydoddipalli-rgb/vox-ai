"""The signed-in user's long-term memories (list, delete)."""

import uuid

from fastapi import APIRouter, Depends, Response

from vox_api.api.deps import CurrentUser, DbSession, rate_limited
from vox_api.core.errors import ProblemError
from vox_api.repositories import memories as memories_repo
from vox_api.schemas.memories import Memory, MemoryList

router = APIRouter(prefix="/memories", tags=["memories"])

NOT_FOUND = "Memory not found"


@router.get("", summary="My memories, newest first")
async def list_memories(user: CurrentUser, db: DbSession) -> MemoryList:
    rows = await memories_repo.list_for_user(db, user.id)
    return MemoryList(memories=[Memory.model_validate(r) for r in rows])


@router.delete(
    "/{memory_id}",
    status_code=204,
    summary="Forget one memory",
    responses={
        404: {"description": "Not found, or not yours (problem+json)"},
        429: {"description": "Rate limited"},
    },
    dependencies=[Depends(rate_limited("memories-delete", limit=30))],
)
async def delete_memory(memory_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    if not await memories_repo.delete_for_user(db, user.id, memory_id):
        raise ProblemError(404, NOT_FOUND)
    return Response(status_code=204)
