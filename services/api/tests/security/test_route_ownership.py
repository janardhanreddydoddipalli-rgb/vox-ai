"""Authorization matrix guard: every route with a path parameter needs a cross-user test.

When M3 adds e.g. GET /v1/interviews/{interview_id}, this test fails until
CROSS_USER_TESTS maps that route to a test (in this package) proving another
user's id returns 404. Today there are no such routes, so it passes trivially
while still checking that the registry and the app agree.
"""

import importlib
import pkgutil

from fastapi.routing import iter_route_contexts
from pydantic import SecretStr

import tests.security
from vox_api.core.config import Settings
from vox_api.main import create_app

# "METHOD /path/{param}" -> "module:test_function" in tests.security
CROSS_USER_TESTS: dict[str, str] = {
    "DELETE /v1/memories/{memory_id}": "test_cross_user:test_delete_memory_of_another_user_is_404",
    "POST /v1/sessions/{session_id}/turns": (
        "test_cross_user:test_post_turns_into_another_users_session_is_404"
    ),
    "GET /v1/sessions/{session_id}/turns": "test_cross_user:test_get_turns_of_another_users_session_is_404",
    "GET /v1/interviews/{interview_id}": "test_cross_user:test_get_interview_of_another_user_is_404",
    "POST /v1/interviews/{interview_id}/end": "test_cross_user:test_end_interview_of_another_user_is_404",
    "GET /v1/interviews/{interview_id}/report.pdf": "test_cross_user:test_report_pdf_of_another_user_is_404",
    "GET /v1/interviews/{interview_id}/steps": "test_cross_user:test_agent_steps_of_another_user_is_404",
}


def _all_routes() -> set[str]:
    # FastAPI keeps included routers nested; iter_route_contexts flattens them
    # (app.routes alone would show none of our API routes).
    app = create_app(_placeholder_settings())
    return {
        f"{method} {ctx.path}"
        for ctx in iter_route_contexts(app.routes)
        for method in (ctx.methods or set()) - {"HEAD", "OPTIONS"}
    }


def _routes_with_path_params() -> set[str]:
    return {r for r in _all_routes() if "{" in r}


def _placeholder_settings() -> Settings:
    return Settings(
        _env_file=None,
        database_url=SecretStr("postgresql://u:p@localhost/unused"),
        web_origin="http://localhost:3000",
        jwt_public_key=SecretStr("unused"),
        internal_api_token=SecretStr("x" * 32),
    )


def _security_test_functions() -> set[str]:
    names: set[str] = set()
    for mod in pkgutil.iter_modules(tests.security.__path__):
        module = importlib.import_module(f"tests.security.{mod.name}")
        names |= {f"{mod.name}:{n}" for n in dir(module) if n.startswith("test_")}
    return names


def test_the_guard_sees_the_real_routes() -> None:
    """Self-check: an enumerator that finds nothing would make this file pass vacuously."""
    routes = _all_routes()
    assert {"GET /v1/me", "POST /internal/users/upsert"} <= routes


def test_every_id_route_has_a_cross_user_test() -> None:
    missing = sorted(_routes_with_path_params() - CROSS_USER_TESTS.keys())
    assert not missing, f"Add a cross-user (404) test for: {missing}"


def test_registry_has_no_stale_routes() -> None:
    stale = sorted(CROSS_USER_TESTS.keys() - _routes_with_path_params())
    assert not stale, f"Routes no longer exist: {stale}"


def test_registered_tests_exist() -> None:
    unknown = sorted(set(CROSS_USER_TESTS.values()) - _security_test_functions())
    assert not unknown, f"Registered cross-user tests not found: {unknown}"
