"""Public API, version 1."""

from fastapi import APIRouter

from vox_api.api.v1 import account, health, interviews, me, memories, turns

router = APIRouter()
router.include_router(health.router)
router.include_router(me.router)
router.include_router(memories.router)
router.include_router(turns.router)
router.include_router(interviews.router)
router.include_router(account.router)
