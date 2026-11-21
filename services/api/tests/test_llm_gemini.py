"""GeminiProvider against a mocked transport (no network, no paid calls)."""

import json
import math
from typing import Any

import httpx
import pytest

from vox_api.llm.base import LLMError, Message
from vox_api.llm.gemini import GeminiProvider


def provider(handler: Any) -> tuple[GeminiProvider, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        response: httpx.Response = handler(request)
        return response

    client = httpx.AsyncClient(transport=httpx.MockTransport(record))
    return GeminiProvider("test-key", "gemini-test", "embed-test", client=client), seen


def reply(text: str, usage: dict[str, int] | None = None) -> httpx.Response:
    body: dict[str, Any] = {"candidates": [{"content": {"parts": [{"text": text}]}}]}
    if usage:
        body["usageMetadata"] = usage
    return httpx.Response(200, json=body)


async def test_generate_sends_system_schema_and_reads_usage() -> None:
    llm, seen = provider(lambda r: reply('{"ok":true}', {"promptTokenCount": 12, "candidatesTokenCount": 3}))
    gen = await llm.generate(
        [Message("user", "hi")], system="Be brief.", response_schema={"type": "object"}, temperature=0.2
    )
    assert (gen.text, gen.tokens_in, gen.tokens_out, gen.model) == ('{"ok":true}', 12, 3, "gemini-test")
    req = seen[0]
    assert req.url.path.endswith("/models/gemini-test:generateContent")
    assert req.headers["x-goog-api-key"] == "test-key"
    body = json.loads(req.content)
    assert body["systemInstruction"] == {"parts": [{"text": "Be brief."}]}
    assert body["generationConfig"] == {
        "temperature": 0.2,
        "responseMimeType": "application/json",
        "responseSchema": {"type": "object"},
    }


@pytest.mark.parametrize("response", [httpx.Response(429, json={}), reply("")])
async def test_generate_errors_raise_llm_error(response: httpx.Response) -> None:
    llm, _ = provider(lambda r: response)
    with pytest.raises(LLMError):
        await llm.generate([Message("user", "hi")])


async def test_stream_yields_text_chunks() -> None:
    events = [{"candidates": [{"content": {"parts": [{"text": t}]}}]} for t in ["He", "llo"]]
    sse = "".join(f"data: {json.dumps(e)}\r\n\r\n" for e in events)
    llm, seen = provider(lambda r: httpx.Response(200, text=sse))
    chunks = [c async for c in llm.stream([Message("user", "hi")])]
    assert chunks == ["He", "llo"]
    assert seen[0].url.params["alt"] == "sse"


async def test_embed_requests_768_dims_with_task_type_and_normalises() -> None:
    llm, seen = provider(lambda r: httpx.Response(200, json={"embeddings": [{"values": [3.0] * 768}]}))
    [vec] = await llm.embed(["text"], task="RETRIEVAL_QUERY")
    req = json.loads(seen[0].content)["requests"][0]
    assert (req["taskType"], req["outputDimensionality"], req["model"]) == (
        "RETRIEVAL_QUERY",
        768,
        "models/embed-test",
    )
    assert math.isclose(math.sqrt(sum(x * x for x in vec)), 1.0)


async def test_embed_rejects_wrong_dimensions() -> None:
    llm, _ = provider(lambda r: httpx.Response(200, json={"embeddings": [{"values": [1.0] * 3072}]}))
    with pytest.raises(LLMError, match="malformed"):
        await llm.embed(["text"], task="RETRIEVAL_DOCUMENT")
