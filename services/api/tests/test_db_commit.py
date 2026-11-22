"""A request's writes are committed before its response is sent.

If the commit ran after the response (FastAPI's default for `yield` dependencies),
a client could act on a 200 before the data exists (E2E: a user signed in, then got
401 "Unknown user"), and a failed commit would still have been reported as success.
"""

import json
import uuid
from collections.abc import MutableMapping
from typing import Any

from fastapi import FastAPI

from tests.conftest import INTERNAL_TOKEN
from tests.helpers import count_rows


async def test_writes_are_committed_before_the_response_starts(app: FastAPI, database_url: str) -> None:
    email = f"commit-{uuid.uuid4().hex[:8]}@example.com"
    body = json.dumps({"email": email, "name": None, "image": None}).encode()
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/internal/users/upsert",
        "raw_path": b"/internal/users/upsert",
        "query_string": b"",
        "root_path": "",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"x-internal-token", INTERNAL_TOKEN.encode()),
        ],
        "client": ("127.0.0.1", 1),
        "server": ("testserver", 80),
    }
    seen: dict[str, int] = {}

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": body, "more_body": False}

    async def send(message: MutableMapping[str, Any]) -> None:
        if message["type"] == "http.response.start":
            # Another connection, at the moment the client would get the status.
            seen["status"] = message["status"]
            seen["committed_rows"] = await count_rows(database_url, "users", "email = $1", email)

    await app(scope, receive, send)

    assert seen == {"status": 200, "committed_rows": 1}
