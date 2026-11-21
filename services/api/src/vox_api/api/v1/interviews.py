"""Interviews: create (with optional résumé PDF), read, end with a report, PDF, debug steps."""

import uuid
from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from pydantic import StringConstraints

from vox_api.api.deps import CurrentUser, DbSession, LLMDep, SettingsDep, rate_limited
from vox_api.core.errors import ProblemError
from vox_api.llm.base import LLMError
from vox_api.rag.ingest import index_document
from vox_api.repositories import interviews as repo
from vox_api.schemas.interviews import (
    AgentStepOut,
    AgentSteps,
    EndResult,
    InterviewCreated,
    InterviewDetail,
    InterviewList,
    InterviewSummary,
    Language,
    Level,
    QaItem,
    ScoreList,
    ScorePoint,
)
from vox_api.services import cost_guard, memory, report, report_pdf, resume

router = APIRouter(prefix="/interviews", tags=["interviews"])
log = structlog.get_logger("vox_api.interviews")

MAX_RESUME_BYTES = 5_000_000
NOT_FOUND = "Interview not found"
RESPONSES_404: dict[int | str, dict[str, Any]] = {
    404: {"description": "Not found, or not yours (problem+json)"}
}


async def _owned(db: DbSession, user: CurrentUser, interview_id: uuid.UUID) -> Any:
    interview = await repo.get_owned(db, user.id, interview_id)
    if interview is None:
        raise ProblemError(404, NOT_FOUND)
    return interview


@router.post(
    "",
    status_code=201,
    summary="Start an interview (optionally with a résumé PDF and a job description)",
    responses={400: {"description": "Unreadable or oversized résumé"}, 429: {"description": "Rate limited"}},
    dependencies=[Depends(rate_limited("interviews", limit=30))],
)
async def create_interview(
    user: CurrentUser,
    db: DbSession,
    llm: LLMDep,
    settings: SettingsDep,
    role: Annotated[str, Form(), StringConstraints(strip_whitespace=True, min_length=1, max_length=80)],
    level: Annotated[Level, Form()],
    language: Annotated[Language, Form()] = "en",
    job_description: Annotated[str, Form(), StringConstraints(strip_whitespace=True, max_length=8000)] = "",
    resume_file: Annotated[UploadFile | None, File(alias="resume")] = None,
) -> InterviewCreated:
    resume_id = None
    tokens_in = tokens_out = 0
    if resume_file is not None and resume_file.size:
        if resume_file.size > MAX_RESUME_BYTES:
            raise ProblemError(400, "Resume PDF must be 5 MB or smaller")
        if resume_file.content_type and resume_file.content_type != "application/pdf":
            raise ProblemError(400, "Resume must be a PDF")
        try:
            raw_text = resume.extract_pdf_text(await resume_file.read())
        except resume.PdfTextError as exc:
            raise ProblemError(400, "Could not read text from that PDF") from exc
        parsed, gen = await resume.parse_structure(llm, raw_text)
        if gen:
            tokens_in, tokens_out = gen.tokens_in, gen.tokens_out
        saved = await repo.create_resume(
            db, user.id, resume_file.filename or "resume.pdf", raw_text, parsed.__dict__
        )
        resume_id = saved.id
        tokens_in += await _index_best_effort(db, llm, user.id, "resume", raw_text)

    interview = await repo.create(
        db,
        user.id,
        role=role,
        level=level,
        language=language,
        job_description=job_description or None,
        resume_id=resume_id,
    )
    if job_description:
        tokens_in += await _index_best_effort(db, llm, user.id, "jd", job_description)
    await cost_guard.record(db, user.id, tokens_in, tokens_out, settings.daily_token_budget)
    return InterviewCreated(id=interview.id)


async def _index_best_effort(db: DbSession, llm: LLMDep, user_id: uuid.UUID, source: str, text: str) -> int:
    """Index for RAG; the interview proceeds without embeddings. Returns estimated tokens."""
    if llm is None:
        return 0
    try:
        async with db.begin_nested():
            chunks = await index_document(db, llm, user_id, source, text)
    except LLMError as exc:
        log.warning("doc_indexing_failed", source=source, error_type=type(exc).__name__)
        return 0
    return cost_guard.estimate_tokens(chunks)


@router.get("", summary="My interviews, newest first (max 50)")
async def list_interviews(user: CurrentUser, db: DbSession) -> InterviewList:
    rows = await repo.list_for_user(db, user.id)
    return InterviewList(
        interviews=[
            InterviewSummary(
                id=r.id,
                role=r.role,
                level=r.level,
                status=r.status,
                language=r.language,
                overall=(r.report or {}).get("overall"),
                created_at=r.created_at,
            )
            for r in rows
        ]
    )


@router.get("/scores", summary="Every answered question's score across my interviews (oldest first)")
async def list_scores(user: CurrentUser, db: DbSession) -> ScoreList:
    rows = await repo.scores_for_user(db, user.id)
    return ScoreList(
        scores=[
            ScorePoint(
                interview_id=r.interview_id,
                order=r.order,
                score=(r.evaluation or {}).get("score"),
                created_at=r.created_at,
            )
            for r in rows
        ]
    )


@router.get("/{interview_id}", summary="One of my interviews with its answers", responses=RESPONSES_404)
async def get_interview(interview_id: uuid.UUID, user: CurrentUser, db: DbSession) -> InterviewDetail:
    iv = await _owned(db, user, interview_id)
    qa = await repo.qa_for(db, iv.id)
    return InterviewDetail(
        id=iv.id,
        role=iv.role,
        level=iv.level,
        status=iv.status,
        language=iv.language,
        has_resume=iv.resume_id is not None,
        current_question_index=iv.current_question_index,
        created_at=iv.created_at,
        completed_at=iv.completed_at,
        report=iv.report,
        qa=[
            QaItem(
                id=q.id,
                order=q.order,
                question_id=q.question_id,
                question=q.question_text,
                answer=q.answer_text,
                evaluation=q.evaluation,
                created_at=q.created_at,
            )
            for q in qa
        ],
    )


@router.post(
    "/{interview_id}/end",
    summary="End the interview: generate (or reuse) the report, then distill memories",
    responses={**RESPONSES_404, 502: {"description": "Report generation failed"}},
)
async def end_interview(
    interview_id: uuid.UUID, user: CurrentUser, db: DbSession, llm: LLMDep, settings: SettingsDep
) -> EndResult:
    iv = await _owned(db, user, interview_id)
    if iv.report:
        return EndResult(id=iv.id, report=iv.report)
    qa = await repo.qa_for(db, iv.id)
    try:
        result, gen = await report.generate(llm, iv, qa)
    except LLMError as exc:
        log.error("report_generation_failed", error_type=type(exc).__name__)
        raise ProblemError(502, "Could not generate the report. Please try again.") from exc
    report_json = result.model_dump()
    await repo.save_report(db, iv, report_json)
    tokens_in, tokens_out = (gen.tokens_in, gen.tokens_out) if gen else (0, 0)

    # Best-effort: the report stands even if the memory summary fails.
    if llm is not None and qa:
        try:
            async with db.begin_nested():
                summary = await memory.summarize(db, llm, user.id, qa)
            tokens_in += summary.tokens_in + cost_guard.estimate_tokens(summary.embedded_texts)
            tokens_out += summary.tokens_out
        except (LLMError, ValueError) as exc:
            log.warning("memory_summarization_failed", error_type=type(exc).__name__)
    await cost_guard.record(db, user.id, tokens_in, tokens_out, settings.daily_token_budget)
    return EndResult(id=iv.id, report=report_json)


@router.get(
    "/{interview_id}/report.pdf",
    summary="The report as a PDF",
    response_class=Response,
    responses={**RESPONSES_404, 200: {"content": {"application/pdf": {}}}},
)
async def report_as_pdf(interview_id: uuid.UUID, user: CurrentUser, db: DbSession) -> Response:
    iv = await _owned(db, user, interview_id)
    if not iv.report:
        raise ProblemError(404, "Report not found")
    pdf = report_pdf.report_pdf(iv, await repo.qa_for(db, iv.id))
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="vox-interview-{str(iv.id)[:8]}.pdf"'},
    )


@router.get("/{interview_id}/steps", summary="Agent tool steps (debugging)", responses=RESPONSES_404)
async def agent_steps(interview_id: uuid.UUID, user: CurrentUser, db: DbSession) -> AgentSteps:
    iv = await _owned(db, user, interview_id)
    return AgentSteps(steps=[AgentStepOut.model_validate(s) for s in await repo.steps_for(db, iv.id)])
