"""Public API, version 1."""

from fastapi import APIRouter

from vox_api.api.v1 import health, me, memories

router = APIRouter()
router.include_router(health.router)
router.include_router(me.router)
router.include_router(memories.router)
