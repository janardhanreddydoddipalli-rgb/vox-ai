"""Gemini over its REST API (same requests apps/web makes). The key never leaves the server."""

import json
import math
from collections.abc import AsyncGenerator, Sequence
from typing import Any

import httpx

from vox_api.llm.base import (
    Conversation,
    EmbeddingTask,
    Generation,
    LLMError,
    Message,
    ModelTurn,
    StreamChunk,
    ToolCall,
    ToolSpec,
)
from vox_api.models.memory import EMBEDDING_DIMENSIONS

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def _l2_normalize(v: list[float]) -> list[float]:
    # Truncated (768-dim) embeddings aren't unit length; dot product must equal cosine.
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


def _contents(items: Conversation) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, Message):
            out.append({"role": item.role, "parts": [{"text": item.text}]})
            continue
        parts: list[dict[str, Any]] = []
        if item.text is not None:
            parts.append({"text": item.text})
        parts += [{"functionCall": {"name": c.name, "args": c.args}} for c in item.calls]
        parts += [{"functionResponse": {"name": n, "response": {"result": r}}} for n, r in item.results]
        out.append({"role": item.role, "parts": parts})
    return out


def _parts(data: dict[str, Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = ((data.get("candidates") or [{}])[0].get("content") or {}).get(
        "parts"
    ) or []
    return parts


def _reply_text(data: dict[str, Any]) -> str:
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(str(p.get("text", "")) for p in parts)


class GeminiProvider:
    def __init__(
        self, api_key: str, model: str, embedding_model: str, *, client: httpx.AsyncClient | None = None
    ) -> None:
        self.model = model
        self.embedding_model = embedding_model
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
        self._headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    def _body(
        self,
        messages: Conversation,
        system: str | None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"contents": _contents(messages)}
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        config: dict[str, Any] = {}
        if temperature is not None:
            config["temperature"] = temperature
        if max_output_tokens is not None:
            config["maxOutputTokens"] = max_output_tokens
        if response_schema is not None:
            config["responseMimeType"] = "application/json"
            config["responseSchema"] = response_schema
        if config:
            body["generationConfig"] = config
        return body

    async def generate(
        self,
        messages: Conversation,
        *,
        system: str | None = None,
        response_schema: dict[str, Any] | None = None,
        temperature: float | None = None,
    ) -> Generation:
        try:
            res = await self._client.post(
                f"{BASE_URL}/models/{self.model}:generateContent",
                headers=self._headers,
                json=self._body(messages, system, response_schema, temperature),
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini request failed: {type(exc).__name__}") from exc
        if res.status_code != 200:
            raise LLMError(f"Gemini generateContent failed: {res.status_code}")
        data = res.json()
        text = _reply_text(data)
        if not text:
            raise LLMError("Gemini returned an empty reply")
        usage = data.get("usageMetadata") or {}
        return Generation(
            text=text,
            tokens_in=int(usage.get("promptTokenCount", 0)),
            tokens_out=int(usage.get("candidatesTokenCount", 0)),
            model=self.model,
        )

    async def generate_turn(
        self,
        turns: Conversation,
        *,
        system: str | None,
        tools: Sequence[ToolSpec],
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> ModelTurn:
        body = self._body(turns, system, temperature=temperature, max_output_tokens=max_output_tokens)
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": t.name, "description": t.description, "parameters": t.parameters}
                        for t in tools
                    ]
                }
            ]
        try:
            res = await self._client.post(
                f"{BASE_URL}/models/{self.model}:generateContent", headers=self._headers, json=body
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini request failed: {type(exc).__name__}") from exc
        if res.status_code != 200:
            raise LLMError(f"Gemini generateContent failed: {res.status_code}")
        data = res.json()
        parts = _parts(data)
        usage = data.get("usageMetadata") or {}
        return ModelTurn(
            text="".join(str(p.get("text", "")) for p in parts).strip(),
            calls=[
                ToolCall(str(p["functionCall"].get("name", "")), dict(p["functionCall"].get("args") or {}))
                for p in parts
                if p.get("functionCall")
            ],
            tokens_in=int(usage.get("promptTokenCount", 0)),
            tokens_out=int(usage.get("candidatesTokenCount", 0)),
        )

    async def stream(
        self,
        messages: Conversation,
        *,
        system: str | None = None,
        temperature: float | None = None,
        max_output_tokens: int | None = None,
    ) -> AsyncGenerator[StreamChunk]:
        url = f"{BASE_URL}/models/{self.model}:streamGenerateContent?alt=sse"
        body = self._body(messages, system, temperature=temperature, max_output_tokens=max_output_tokens)
        try:
            async with self._client.stream("POST", url, headers=self._headers, json=body) as res:
                if res.status_code != 200:
                    raise LLMError(f"Gemini streamGenerateContent failed: {res.status_code}")
                async for line in res.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                    except json.JSONDecodeError:
                        continue
                    usage = event.get("usageMetadata") or {}
                    chunk = StreamChunk(
                        _reply_text(event),
                        int(usage.get("promptTokenCount", 0)),
                        int(usage.get("candidatesTokenCount", 0)),
                    )
                    if chunk.text or chunk.tokens_in or chunk.tokens_out:
                        yield chunk
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini stream failed: {type(exc).__name__}") from exc

    async def embed(self, texts: Sequence[str], *, task: EmbeddingTask) -> list[list[float]]:
        if not texts:
            return []
        requests = [
            {
                "model": f"models/{self.embedding_model}",
                "content": {"parts": [{"text": t}]},
                "taskType": task,
                "outputDimensionality": EMBEDDING_DIMENSIONS,
            }
            for t in texts
        ]
        try:
            res = await self._client.post(
                f"{BASE_URL}/models/{self.embedding_model}:batchEmbedContents",
                headers=self._headers,
                json={"requests": requests},
            )
        except httpx.HTTPError as exc:
            raise LLMError(f"Gemini embeddings failed: {type(exc).__name__}") from exc
        if res.status_code != 200:
            raise LLMError(f"Gemini embeddings failed: {res.status_code}")
        vectors = [e.get("values", []) for e in res.json().get("embeddings", [])]
        if len(vectors) != len(texts) or any(len(v) != EMBEDDING_DIMENSIONS for v in vectors):
            raise LLMError("Gemini embeddings returned a malformed response")
        return [_l2_normalize([float(x) for x in v]) for v in vectors]
