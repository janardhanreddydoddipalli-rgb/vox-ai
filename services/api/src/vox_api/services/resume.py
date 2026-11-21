"""Résumé parsing: PDF text, then structured skills/projects/experience (port of apps/web lib/resume.ts).

Falls back to a line heuristic when no model is configured or the model fails;
the raw text is always stored so read_resume still works.
"""

import io
import json
import re
from dataclasses import dataclass, field
from typing import Any

import structlog
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from vox_api.llm.base import Generation, LLMError, LLMProvider, Message

log = structlog.get_logger("vox_api.resume")

MAX_TEXT = 40_000
RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "skills": {"type": "array", "items": {"type": "string"}},
        "projects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "summary": {"type": "string"}},
                "required": ["name", "summary"],
            },
        },
        "experience": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "company": {"type": "string"},
                    "role": {"type": "string"},
                    "period": {"type": "string", "nullable": True},
                },
                "required": ["company", "role"],
            },
        },
    },
    "required": ["skills", "projects", "experience"],
}


class PdfTextError(Exception):
    """The upload isn't a readable PDF or has no text."""


@dataclass
class ParsedResume:
    skills: list[str] = field(default_factory=list)
    projects: list[dict[str, str]] = field(default_factory=list)
    experience: list[dict[str, str | None]] = field(default_factory=list)


def extract_pdf_text(data: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise PdfTextError("unreadable PDF") from exc
    text = text.replace("\x00", " ").strip()[:MAX_TEXT]
    if not text:
        raise PdfTextError("no text in PDF")
    return text


def heuristic_parse(raw_text: str) -> ParsedResume:
    lines = [line.strip() for line in re.split(r"\n+", raw_text) if line.strip()]
    skill_line = next((line for line in lines if re.search(r"skill", line, re.I)), None)
    project_line = next((line for line in lines if re.search(r"project", line, re.I)), None)
    skills: list[str] = []
    if skill_line:
        rest = re.sub(r".*skills?:?", "", skill_line, count=1, flags=re.I)
        skills = [s.strip() for s in re.split(r"[,•|]", rest) if s.strip()][:30]
    projects = [{"name": "Resume projects", "summary": project_line[:300]}] if project_line else []
    return ParsedResume(skills=skills, projects=projects)


def _from_model(text: str) -> ParsedResume:
    parsed = json.loads(text)
    return ParsedResume(
        skills=[str(s) for s in (parsed.get("skills") or [])[:50]],
        projects=[
            {"name": str(p.get("name") or "Untitled project"), "summary": str(p.get("summary") or "")}
            for p in (parsed.get("projects") or [])[:20]
        ],
        experience=[
            {
                "company": str(e.get("company") or "Unknown"),
                "role": str(e.get("role") or ""),
                "period": None if e.get("period") is None else str(e.get("period")),
            }
            for e in (parsed.get("experience") or [])[:20]
        ],
    )


async def parse_structure(llm: LLMProvider | None, raw_text: str) -> tuple[ParsedResume, Generation | None]:
    """Structured résumé plus the model generation (for metering), or the heuristic."""
    if llm is None:
        return heuristic_parse(raw_text), None
    prompt = (
        "Extract from this resume: skills (short names), projects (name + one-sentence summary), "
        "experience (company, role, period if present). Resume text:\n\n" + raw_text[:12000]
    )
    try:
        gen = await llm.generate([Message("user", prompt)], response_schema=RESPONSE_SCHEMA, temperature=0.1)
        return _from_model(gen.text), gen
    except (LLMError, json.JSONDecodeError, AttributeError, TypeError) as exc:
        log.warning("resume_structure_fallback", error_type=type(exc).__name__)
        return heuristic_parse(raw_text), None
