"""Playground history: save and read the signed-in user's own sessions."""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path

from vox_api.api.deps import CurrentUser, DbSession, rate_limited
from vox_api.core.errors import ProblemError
from vox_api.repositories import turns as turns_repo
from vox_api.schemas.turns import AllTurns, SessionTurns, Turn, TurnsIn

router = APIRouter(tags=["turns"])

SessionId = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")]
NOT_FOUND: dict[int | str, dict[str, Any]] = {404: {"description": "Not found, or not yours (problem+json)"}}


@router.get("/turns", summary="All my sessions and their turns")
async def list_turns(user: CurrentUser, db: DbSession) -> AllTurns:
    ids = await turns_repo.session_ids_for_user(db, user.id)
    rows = await turns_repo.turns_for_sessions(db, ids)
    return AllTurns(sessions=ids, turns=[Turn.model_validate(r) for r in rows])


@router.get("/sessions/{session_id}/turns", summary="One of my sessions", responses=NOT_FOUND)
async def session_turns(session_id: SessionId, user: CurrentUser, db: DbSession) -> SessionTurns:
    if not await turns_repo.owns_session(db, user.id, session_id):
        raise ProblemError(404, "Session not found")
    rows = await turns_repo.turns_for_sessions(db, [session_id])
    return SessionTurns(session_id=session_id, turns=[Turn.model_validate(r) for r in rows])


@router.post(
    "/sessions/{session_id}/turns",
    summary="Append turns to my session (created on first save)",
    responses={**NOT_FOUND, 429: {"description": "Rate limited"}},
    dependencies=[Depends(rate_limited("turns", limit=30))],
)
async def save_turns(session_id: SessionId, body: TurnsIn, user: CurrentUser, db: DbSession) -> SessionTurns:
    # The id is client-chosen: an existing session of another user is a 404, before any write.
    if not await turns_repo.claim_session(db, user.id, session_id, body.mode):
        raise ProblemError(404, "Session not found")
    await turns_repo.add_turns(db, session_id, body.turns)
    rows = await turns_repo.turns_for_sessions(db, [session_id])
    return SessionTurns(session_id=session_id, turns=[Turn.model_validate(r) for r in rows])
