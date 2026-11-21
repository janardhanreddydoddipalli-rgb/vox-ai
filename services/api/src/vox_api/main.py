"""App factory: settings, logging, Sentry, middleware, error handlers and routers."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from vox_api import __version__
from vox_api.api.internal import router as internal_router
from vox_api.api.v1 import router as v1_router
from vox_api.core.config import Settings, get_settings
from vox_api.core.db import create_engine, create_session_factory
from vox_api.core.errors import install_error_handlers
from vox_api.core.logging import configure_logging
from vox_api.core.middleware import REQUEST_ID_HEADER, RequestContextMiddleware
from vox_api.observability.sentry import init_sentry


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    init_sentry(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_engine(settings.async_database_url)
        app.state.engine = engine
        app.state.session_factory = create_session_factory(engine)
        yield
        await engine.dispose()

    app = FastAPI(
        title="Vox API",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if settings.environment != "production" else None,
        redoc_url=None,
    )
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.web_origin],
        allow_credentials=False,  # bearer tokens, no cookies
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type", REQUEST_ID_HEADER],
        expose_headers=[REQUEST_ID_HEADER],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware)  # outermost: every response gets X-Request-ID
    install_error_handlers(app)

    app.include_router(v1_router, prefix="/v1")
    app.include_router(internal_router, prefix="/internal", include_in_schema=False)
    return app
