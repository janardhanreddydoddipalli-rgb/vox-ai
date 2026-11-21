"""Liveness (process up) and readiness (database reachable) probes."""

from fastapi import APIRouter
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from vox_api.api.deps import DbSession
from vox_api.core.errors import ProblemError
from vox_api.schemas.health import Health, Readiness

router = APIRouter(prefix="/health", tags=["health"])


@router.get("", summary="Liveness: the process is up")
async def health() -> Health:
    return Health()


@router.get(
    "/ready",
    summary="Readiness: the database answers",
    responses={503: {"description": "Database unreachable (problem+json)"}},
)
async def ready(db: DbSession) -> Readiness:
    try:
        await db.execute(text("select 1"))
    except (SQLAlchemyError, OSError) as exc:
        raise ProblemError(503, "Database unavailable") from exc
    return Readiness()
