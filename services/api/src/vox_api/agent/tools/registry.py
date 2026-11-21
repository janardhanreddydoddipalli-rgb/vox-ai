"""The explicit tool list: the text agent and the live-voice bridge expose exactly these.

No import side effects (the web registry was filled by imports, and the live-voice
route ended up with no tools).
"""

from vox_api.agent.tools import (
    end_interview,
    evaluate_answer,
    get_question,
    read_resume,
    recall_memories,
    search_documents,
)
from vox_api.agent.tools.base import Tool
from vox_api.llm.base import ToolSpec

TOOLS: tuple[Tool, ...] = (
    get_question.TOOL,
    evaluate_answer.TOOL,
    end_interview.TOOL,
    read_resume.TOOL,
    recall_memories.TOOL,
    search_documents.TOOL,
)
_BY_NAME = {t.name: t for t in TOOLS}


def get_tool(name: str) -> Tool | None:
    return _BY_NAME.get(name)


def tool_specs() -> list[ToolSpec]:
    return [t.spec() for t in TOOLS]
