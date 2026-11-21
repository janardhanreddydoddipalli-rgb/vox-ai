"""Service-to-service endpoints (apps/web → api), hidden from the public OpenAPI."""

from fastapi import APIRouter

from vox_api.api.internal import users

router = APIRouter()
router.include_router(users.router)
