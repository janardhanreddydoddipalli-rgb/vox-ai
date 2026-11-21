"""read_resume: the candidate's résumé as structured JSON."""

from typing import Any

from pydantic import BaseModel

from vox_api.agent.tools.base import Tool, ToolContext
from vox_api.agent.tools.common import interview_resume


class ReadResumeIn(BaseModel):
    pass


async def handler(args: ReadResumeIn, ctx: ToolContext) -> dict[str, Any]:
    if ctx.interview is None:
        return {"error": "No active interview"}
    if ctx.interview.resume_id is None:
        return {"error": "No resume was provided for this interview"}
    resume = await interview_resume(ctx)
    if resume is None:
        return {"error": "Resume not found"}
    return {"skills": resume.skills, "projects": resume.projects, "experience": resume.experience}


TOOL = Tool(
    name="read_resume",
    description=(
        "Read the candidate's résumé as structured JSON: skills, projects (name + summary), experience "
        "(company, role, period). Call before asking résumé-based questions."
    ),
    input_model=ReadResumeIn,
    handler=handler,
)
