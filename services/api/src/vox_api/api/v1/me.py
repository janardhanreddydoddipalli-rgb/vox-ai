"""The signed-in user's own profile."""

from fastapi import APIRouter

from vox_api.api.deps import CurrentUser
from vox_api.schemas.users import Me

router = APIRouter(tags=["users"])


@router.get(
    "/me",
    summary="The signed-in user",
    responses={401: {"description": "Missing, invalid or expired token (problem+json)"}},
)
async def me(user: CurrentUser) -> Me:
    return Me.model_validate(user)
