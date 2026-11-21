"""Sentry error monitoring: user id only, never request bodies, cookies or auth headers."""

from typing import Any

import sentry_sdk

from vox_api.core.config import Settings

_SENSITIVE_HEADERS = {"authorization", "cookie", "x-internal-token"}


def _scrub(event: Any, _hint: Any) -> Any:
    request = event.get("request")
    if isinstance(request, dict):
        request.pop("data", None)  # bodies can hold résumé or answer text
        request.pop("cookies", None)
        headers = request.get("headers")
        if isinstance(headers, dict):
            for key in list(headers):
                if key.lower() in _SENSITIVE_HEADERS:
                    headers[key] = "[removed]"
    user = event.get("user")
    if isinstance(user, dict):
        event["user"] = {"id": user["id"]} if "id" in user else {}
    return event


def init_sentry(settings: Settings) -> bool:
    """Start Sentry if a DSN is configured. Returns whether it was enabled."""
    if settings.sentry_dsn is None:
        return False
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.environment,
        traces_sample_rate=settings.sentry_traces_sample_rate,
        send_default_pii=False,
        max_request_body_size="never",
        before_send=_scrub,
    )
    return True


def set_user(user_id: str) -> None:
    sentry_sdk.set_user({"id": user_id})
