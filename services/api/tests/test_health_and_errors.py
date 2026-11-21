import uuid

from httpx import AsyncClient
from pydantic import SecretStr

from tests.conftest import WEB_ORIGIN
from vox_api.core.config import Settings
from vox_api.main import create_app

PROBLEM = "application/problem+json"


async def test_liveness(client: AsyncClient) -> None:
    res = await client.get("/v1/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_readiness_checks_the_database(client: AsyncClient) -> None:
    res = await client.get("/v1/health/ready")
    assert res.status_code == 200
    assert res.json() == {"status": "ready", "database": "ok"}


async def test_readiness_is_503_problem_when_the_database_is_down(settings: Settings) -> None:
    broken = settings.model_copy(update={"database_url": SecretStr("postgresql://nobody:x@127.0.0.1:1/none")})
    app = create_app(broken)
    async with app.router.lifespan_context(app):
        from httpx import ASGITransport

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as c:
            res = await c.get("/v1/health/ready")
    assert res.status_code == 503
    assert res.headers["content-type"] == PROBLEM
    assert res.json()["detail"] == "Database unavailable"


async def test_unknown_route_is_404_problem(client: AsyncClient) -> None:
    res = await client.get("/v1/does-not-exist")
    assert res.status_code == 404
    assert res.headers["content-type"] == PROBLEM
    body = res.json()
    assert body["status"] == 404
    assert body["title"] == "Not Found"
    assert body["instance"] == "/v1/does-not-exist"
    assert body["request_id"] == res.headers["x-request-id"]


async def test_validation_error_is_422_problem_without_echoing_input(client: AsyncClient) -> None:
    secret = "candidate-private-answer-text"
    res = await client.post(
        "/internal/users/upsert",
        headers={"X-Internal-Token": "test-internal-token-0123456789abcdef"},
        json={"email": secret},
    )
    assert res.status_code == 422
    assert res.headers["content-type"] == PROBLEM
    assert res.json()["errors"][0]["loc"] == ["body", "email"]
    assert secret not in res.text


async def test_request_id_is_echoed_when_valid(client: AsyncClient) -> None:
    res = await client.get("/v1/health", headers={"X-Request-ID": "trace-abc.123"})
    assert res.headers["x-request-id"] == "trace-abc.123"


async def test_request_id_is_replaced_when_unsafe(client: AsyncClient) -> None:
    res = await client.get("/v1/health", headers={"X-Request-ID": "bad id\r\nInjected: 1"})
    generated = res.headers["x-request-id"]
    assert generated != "bad id\r\nInjected: 1"
    uuid.UUID(hex=generated)


async def test_cors_allows_only_the_web_origin(client: AsyncClient) -> None:
    allowed = await client.options(
        "/v1/me", headers={"Origin": WEB_ORIGIN, "Access-Control-Request-Method": "GET"}
    )
    assert allowed.headers["access-control-allow-origin"] == WEB_ORIGIN
    blocked = await client.options(
        "/v1/me", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}
    )
    assert "access-control-allow-origin" not in blocked.headers


async def test_docs_and_schema_are_hidden_in_production(settings: Settings) -> None:
    from httpx import ASGITransport

    prod = create_app(settings.model_copy(update={"environment": "production"}))
    async with AsyncClient(transport=ASGITransport(app=prod), base_url="http://testserver") as c:
        assert (await c.get("/docs")).status_code == 404
        assert (await c.get("/openapi.json")).status_code == 404
    assert "/v1/me" in prod.openapi()["paths"]  # still generated from code for the client
