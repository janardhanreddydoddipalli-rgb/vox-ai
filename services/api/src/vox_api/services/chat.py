"""Free-form voice chat as Server-Sent Events (port of apps/web /api/chat, non-interview mode).

Events, identical to the web route: meta → token* / sentence* → done, or error
when the stream dies mid-reply. With no model, or a failure before the first
token, an offline reply is spoken instead (meta.engine = "offline").
"""

import datetime as dt
import json
import re
import time
from collections.abc import AsyncGenerator, Sequence
from contextlib import aclosing
from dataclasses import dataclass

import structlog

from vox_api.llm.base import LLMError, LLMProvider, Message

log = structlog.get_logger("vox_api.chat")

SYSTEM_PROMPT = (
    "You are Vox, a concise, friendly voice assistant. Your replies are spoken aloud, "
    "so answer in short, natural spoken sentences (1-3 sentences unless asked for detail). "
    "If asked a question you cannot answer, say so honestly."
)
# Complete sentences keep their delimiter; a trailing fragment is the last match.
_SENTENCE = re.compile(r"[^.!?]+[.!?]+(?:\s|\Z)|[^.!?]+\Z")


def sentences(chunk: str) -> list[str]:
    return _SENTENCE.findall(chunk)


def sse(event: str, data: object) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()


def offline_reply(user_text: str, now: dt.datetime) -> str:
    text = user_text.lower()
    if re.match(r"^(hi|hello|hey)\b", text):
        return "Hello! I'm your voice assistant. What can I do for you?"
    if "time" in text:
        return f"It's {now.strftime('%I').lstrip('0')}:{now.strftime('%M:%S %p')}."
    if "date" in text or "today" in text:
        return f"Today is {now.strftime('%A, %B')} {now.day}, {now.year}."
    if "your name" in text:
        return "I'm Vox, your voice assistant."
    if "thank" in text:
        return "You're welcome!"
    return f"You said: {user_text}. I'm running without a Gemini key right now, so my replies are simple."


@dataclass
class Usage:
    tokens_in: int = 0
    tokens_out: int = 0


async def chat_events(
    llm: LLMProvider | None, user_text: str, history: Sequence[Message], usage: Usage
) -> AsyncGenerator[bytes]:
    started = time.monotonic()

    def elapsed_ms() -> int:
        return round((time.monotonic() - started) * 1000)

    if llm is not None:
        first, full, carry = True, "", ""
        try:
            # aclosing: if the listener disconnects, close the model stream now
            # (not at garbage collection), so the upstream request stops too.
            async with aclosing(
                llm.stream(
                    [*history, Message("user", user_text)],
                    system=SYSTEM_PROMPT,
                    temperature=0.7,
                    max_output_tokens=512,
                )
            ) as stream:
                async for chunk in stream:
                    usage.tokens_in = max(usage.tokens_in, chunk.tokens_in)
                    usage.tokens_out = max(usage.tokens_out, chunk.tokens_out)
                    if not chunk.text:
                        continue
                    if first:
                        first = False
                        yield sse(
                            "meta",
                            {
                                "engine": "gemini",
                                "model": getattr(llm, "model", ""),
                                "first_token_ms": elapsed_ms(),
                            },
                        )
                    full += chunk.text
                    yield sse("token", {"text": chunk.text})
                    carry += chunk.text
                    parts = sentences(carry)
                    carry = parts.pop() if parts else ""
                    for s in parts:
                        yield sse("sentence", {"text": s.strip()})
            if carry.strip():
                yield sse("sentence", {"text": carry.strip()})
            if full.strip():
                yield sse("done", {"total_llm_ms": elapsed_ms()})
                return
            log.error("chat_stream_empty")
        except LLMError as exc:
            log.error("chat_stream_failed", error_type=type(exc).__name__, after_first_token=not first)
            if not first:
                yield sse("error", {"message": "The reply was cut off. Please try again."})
                return

    reason = "Gemini upstream failed" if llm is not None else "GEMINI_API_KEY not configured"
    log.warning("chat_offline_fallback", reason=reason, chars=len(user_text))  # never the text itself
    yield sse("meta", {"engine": "offline", "reason": reason})
    reply = offline_reply(user_text, dt.datetime.now())  # server-local time, like the web route
    parts = sentences(reply)
    tail = parts.pop() if parts else reply
    for s in parts:
        yield sse("sentence", {"text": s.strip()})
    if tail.strip():
        yield sse("sentence", {"text": tail.strip()})
    yield sse("done", {"total_llm_ms": elapsed_ms()})
