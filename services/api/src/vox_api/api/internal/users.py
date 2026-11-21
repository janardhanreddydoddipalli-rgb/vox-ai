"""apps/web → api: resolve a signed-in identity to its stable user id."""

from fastapi import APIRouter, Depends

from vox_api.api.deps import DbSession, require_internal_token
from vox_api.repositories import users as users_repo
from vox_api.schemas.users import UserUpsertIn, UserUpsertOut

router = APIRouter(prefix="/users", dependencies=[Depends(require_internal_token)])


@router.post("/upsert")
async def upsert_user(body: UserUpsertIn, db: DbSession) -> UserUpsertOut:
    user_id = await users_repo.upsert_by_email(db, email=str(body.email), name=body.name, image=body.image)
    return UserUpsertOut(user_id=user_id)
