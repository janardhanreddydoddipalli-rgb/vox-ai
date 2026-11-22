"""Pure checks over one eval case's grading and agent replies (port of apps/web evals/run.ts)."""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

MAX_SPOKEN_WORDS = 80
# Gemini Flash list prices (USD per 1M tokens), for the cost estimate only.
INPUT_USD_PER_1M = 0.5
OUTPUT_USD_PER_1M = 1.5

_INTERROGATIVE = re.compile(r"^(what|how|why|tell me|can you|could you|walk me)\b", re.IGNORECASE)
_MARKDOWN = re.compile(r"(^|\n)\s*[-*#>]|\*\*")


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


def norm(s: str) -> str:
    """Lowercase, punctuation to spaces, whitespace collapsed (so a spoken paraphrase still matches)."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s.lower())).strip()


def question_sentences(reply: str) -> list[str]:
    """Sentences that ask something: end with '?', or open with an interrogative."""
    sentences = [s.strip() for s in re.split(r"(?<=[.?!])\s+", reply) if s.strip()]
    return [s for s in sentences if s.endswith("?") or _INTERROGATIVE.match(s)]


def tool_questions(outputs: Sequence[dict[str, Any]]) -> list[str]:
    """Every question text a tool returned (get_question's question, evaluate_answer's follow-up)."""
    found: list[str] = []
    for out in outputs:
        for key in ("question", "follow_up_question"):
            if isinstance(out.get(key), str):
                found.append(out[key])
    return found


def spoken_length(reply: str) -> Check:
    words = len(reply.split())
    markdown = bool(_MARKDOWN.search(reply))
    return Check(
        "reply-length-speech",
        words <= MAX_SPOKEN_WORDS and not markdown,
        f"{words} words, markdown={markdown}",
    )


def no_invented_questions(reply: str, outputs: Sequence[dict[str, Any]]) -> Check:
    """Every question the interviewer speaks must come from a tool output."""
    allowed = [norm(q) for q in tool_questions(outputs)]
    asked = question_sentences(reply)
    invented = [q for q in asked if not any(a in norm(q) or norm(q) in a for a in allowed)]
    if not asked:
        detail = "no questions asked"
    elif not invented:
        detail = f"all {len(asked)} question(s) tool-sourced"
    else:
        detail = "invented: " + " | ".join(invented)[:160]
    return Check("no-invented-questions", not invented, detail)


def weak_follow_up(reply: str, follow_up_needed: bool) -> Check:
    """A weak answer gets a follow-up: the reply asks something (unless grading saw no need)."""
    asked = bool(re.search(r"\?|follow", reply, re.IGNORECASE)) and (
        not follow_up_needed or bool(question_sentences(reply))
    )
    return Check("weak-follow-up-asked", asked, "follow-up present" if asked else "no follow-up in the reply")


def estimate_cost(tokens_in: int, tokens_out: int) -> float:
    return tokens_in / 1_000_000 * INPUT_USD_PER_1M + tokens_out / 1_000_000 * OUTPUT_USD_PER_1M
