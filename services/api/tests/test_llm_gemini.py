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
    events: list[dict[str, object]] = [
        {"candidates": [{"content": {"parts": [{"text": t}]}}]} for t in ["He", "llo"]
    ]
    events.append({"usageMetadata": {"promptTokenCount": 9, "candidatesTokenCount": 2}})
    sse = "".join(f"data: {json.dumps(e)}\r\n\r\n" for e in events)
    llm, seen = provider(lambda r: httpx.Response(200, text=sse))
    chunks = [c async for c in llm.stream([Message("user", "hi")], temperature=0.7, max_output_tokens=512)]
    assert [c.text for c in chunks] == ["He", "llo", ""]
    assert (chunks[-1].tokens_in, chunks[-1].tokens_out) == (9, 2)
    assert json.loads(seen[0].content)["generationConfig"] == {"temperature": 0.7, "maxOutputTokens": 512}
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


async def test_generate_turn_sends_tools_and_conversation_and_parses_calls() -> None:
    from vox_api.llm.base import ToolCall, ToolSpec, Turn

    body = {
        "candidates": [
            {"content": {"parts": [{"functionCall": {"name": "get_question", "args": {"level": "mid"}}}]}}
        ],
        "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 4},
    }
    llm, seen = provider(lambda r: httpx.Response(200, json=body))
    conversation: list[Message | Turn] = [
        Message("user", "start"),
        Turn("model", calls=(ToolCall("read_resume", {}),)),
        Turn("user", results=(("read_resume", {"skills": ["Go"]}),)),
    ]
    spec = ToolSpec("get_question", "Next question", {"type": "object", "properties": {}, "required": []})

    result = await llm.generate_turn(
        conversation, system="sys", tools=[spec], temperature=0.6, max_output_tokens=1024
    )

    assert result.calls == [ToolCall("get_question", {"level": "mid"})]
    assert (result.text, result.tokens_in, result.tokens_out) == ("", 30, 4)
    sent = json.loads(seen[0].content)
    assert sent["tools"] == [
        {
            "functionDeclarations": [
                {"name": "get_question", "description": "Next question", "parameters": spec.parameters}
            ]
        }
    ]
    assert sent["contents"] == [
        {"role": "user", "parts": [{"text": "start"}]},
        {"role": "model", "parts": [{"functionCall": {"name": "read_resume", "args": {}}}]},
        {
            "role": "user",
            "parts": [
                {"functionResponse": {"name": "read_resume", "response": {"result": {"skills": ["Go"]}}}}
            ],
        },
    ]
    assert sent["generationConfig"] == {"temperature": 0.6, "maxOutputTokens": 1024}
