"""The signed-in user's playground sessions and account deletion."""

from fastapi import APIRouter

from vox_api.api.deps import CurrentUser, DbSession
from vox_api.repositories import interviews as repo
from vox_api.schemas.interviews import DeletedAccount, SessionList, SessionSummary

router = APIRouter(tags=["account"])


@router.get("/sessions", summary="My playground sessions, newest first")
async def list_sessions(user: CurrentUser, db: DbSession) -> SessionList:
    return SessionList(
        sessions=[SessionSummary.model_validate(s) for s in await repo.sessions_for_user(db, user.id)]
    )


@router.delete("/me", summary="Delete my account and everything I own")
async def delete_me(user: CurrentUser, db: DbSession) -> DeletedAccount:
    return DeletedAccount(sessions_deleted=await repo.delete_user_and_data(db, user.id))
