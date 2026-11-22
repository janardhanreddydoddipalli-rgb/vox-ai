"""RFC 9457 problem+json responses for every error the API returns."""

from collections.abc import Mapping
from http import HTTPStatus
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

PROBLEM_JSON = "application/problem+json"
log = structlog.get_logger("vox_api.errors")


class ProblemError(Exception):
    """Raise anywhere to return a problem+json response with this status."""

    def __init__(
        self,
        status: int,
        detail: str | None = None,
        *,
        headers: dict[str, str] | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.headers = headers
        # Machine-readable reason when one status has several meanings (e.g. 429 budget_exceeded).
        self.code = code


def problem_response(
    request: Request,
    status: int,
    detail: str | None = None,
    *,
    headers: Mapping[str, str] | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": HTTPStatus(status).phrase,
        "status": status,
        "instance": request.url.path,
    }
    if detail:
        body["detail"] = detail
    request_id = getattr(request.state, "request_id", None)
    if request_id:
        body["request_id"] = request_id
    if extra:
        body.update(extra)
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON, headers=headers)


async def _problem_error(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, ProblemError):  # registered for this type only
        raise exc
    extra = {"code": exc.code} if exc.code else None
    return problem_response(request, exc.status, exc.detail, headers=exc.headers, extra=extra)


async def _http_error(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, StarletteHTTPException):  # registered for this type only
        raise exc
    detail = (
        exc.detail
        if isinstance(exc.detail, str) and exc.detail != HTTPStatus(exc.status_code).phrase
        else None
    )
    return problem_response(request, exc.status_code, detail, headers=exc.headers)


async def _validation_error(request: Request, exc: Exception) -> JSONResponse:
    if not isinstance(exc, RequestValidationError):  # registered for this type only
        raise exc
    # Location, message and type only: never echo submitted values back
    # (FastAPI's default includes them; they can be résumé or answer text).
    errors = [
        {"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")}
        for e in exc.errors()
    ]
    return problem_response(request, 422, "Request validation failed", extra={"errors": errors})


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled_error", error_type=type(exc).__name__)
    return problem_response(request, 500)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ProblemError, _problem_error)
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _unhandled_error)
