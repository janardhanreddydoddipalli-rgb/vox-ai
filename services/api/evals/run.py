"""Vox evals: 20 scripted candidate answers (weak, average, strong) against the real model
and the real agent loop. Manual only: they cost money and are non-deterministic.

Checks per case: the score is in the expected range; the follow-up policy matches; the
step limit holds; the spoken reply is short and has no markdown; no invented questions
(every question in the reply comes from a tool output); weak answers get a follow-up.
Exits 1 when the pass rate is below EVAL_PASS_THRESHOLD (default 0.9).

Usage (from services/api): TEST_DATABASE_URL=... GEMINI_API_KEY=... uv run python -m evals.run
"""

import asyncio
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from evals.checks import Check, estimate_cost, no_invented_questions, spoken_length, weak_follow_up
from vox_api.agent import loop
from vox_api.agent.tools.base import ToolContext, ToolUsage
from vox_api.agent.tools.evaluate_answer import grade
from vox_api.core.config import async_database_url
from vox_api.core.db import create_engine, create_session_factory
from vox_api.llm.base import LLMProvider, Message
from vox_api.llm.gemini import GeminiProvider
from vox_api.models import User
from vox_api.prompts.interviewer import INTERVIEWER_SYSTEM_PROMPT
from vox_api.repositories import interviews as interviews_repo
from vox_api.repositories import usage as usage_repo
from vox_api.services import question_bank

API_DIR = Path(__file__).resolve().parents[1]
DATASET = Path(__file__).with_name("dataset.jsonl")
CONCURRENCY = 3
WIPE = "TRUNCATE agent_steps, interviews, turns, sessions, users, questions CASCADE"


@dataclass
class CaseResult:
    id: str
    tag: str
    checks: list[Check] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


async def agent_turn(
    ctx: ToolContext, history: list[Message], user_text: str, outputs: list[dict[str, Any]]
) -> loop.LoopResult:
    result = loop.LoopResult()
    async for _ in loop.run(ctx, history, user_text, INTERVIEWER_SYSTEM_PROMPT, result):
        pass
    outputs.extend(s.output for s in result.steps)
    return result


async def run_case(
    case: dict[str, Any], factory: async_sessionmaker[AsyncSession], llm: LLMProvider, user_id: uuid.UUID
) -> CaseResult:
    started = time.monotonic()
    r = CaseResult(case["id"], case["tag"])
    usage = ToolUsage()

    # Slice A: the grading model's score and follow-up decision.
    evaluation: dict[str, Any] | None = None
    try:
        evaluation = await grade(llm, usage, case["question"], case["answer"])
        lo, hi = case["expected_score_min"], case["expected_score_max"]
        r.checks.append(
            Check(
                "score-in-range",
                lo <= evaluation["score"] <= hi,
                f"score {evaluation['score']}, expected {lo}-{hi}",
            )
        )
        follow = evaluation["follow_up_needed"]
        r.checks.append(
            Check("follow-up-policy", follow == case["expect_follow_up"], f"follow_up_needed={follow}")
        )
    except Exception as exc:  # report and keep going: one bad case must not stop the run
        r.checks.append(Check("score-in-range", False, f"grading failed: {type(exc).__name__}"))
        r.checks.append(Check("follow-up-policy", False, "grading failed"))

    # Slice B: the agent loop over a fresh interview (opening question, then the scripted answer).
    async with factory() as db:
        role = "HR" if case["category"] == "hr" else "Engineer"
        interview = await interviews_repo.create(
            db, user_id, role=role, level="mid", language="en", job_description=None, resume_id=None
        )
        ctx = ToolContext(db=db, llm=llm, user_id=user_id, interview=interview, usage=usage)
        outputs: list[dict[str, Any]] = []
        try:
            t1 = await agent_turn(ctx, [], "Start the interview", outputs)
            history = [Message("user", "Start the interview"), Message("model", t1.reply)]
            t2 = await agent_turn(ctx, history, case["answer"], outputs)
            r.tokens_in += t1.tokens_in + t2.tokens_in
            r.tokens_out += t1.tokens_out + t2.tokens_out
            r.checks.append(
                Check(
                    "step-limit",
                    not t1.hit_step_limit and not t2.hit_step_limit,
                    f"steps t1={len(t1.steps)} t2={len(t2.steps)} cap={loop.MAX_TOOL_STEPS}",
                )
            )
            r.checks.append(spoken_length(t2.reply))
            r.checks.append(no_invented_questions(t2.reply, outputs))
            if case["expect_follow_up"] and evaluation is not None:
                r.checks.append(weak_follow_up(t2.reply, evaluation["follow_up_needed"]))
        except Exception as exc:
            r.checks.append(Check("loop-ran", False, f"agent loop failed: {type(exc).__name__}: {exc}"[:200]))
        r.tokens_in += usage.tokens_in
        r.tokens_out += usage.tokens_out
        await usage_repo.add_usage(db, user_id, r.tokens_in, r.tokens_out)  # evals are a paid path too
        await db.commit()

    r.latency_ms = round((time.monotonic() - started) * 1000)
    return r


def report(results: list[CaseResult], threshold: float) -> float:
    print("\nPer-tag pass rates:")
    for tag in ("weak", "average", "strong"):
        rs = [r for r in results if r.tag == tag]
        ok = sum(r.passed for r in rs)
        print(f"  {tag:<8} {ok / len(rs) * 100 if rs else 0:.0f}%  ({ok}/{len(rs)})")
    rate = sum(r.passed for r in results) / len(results)
    tokens_in = sum(r.tokens_in for r in results)
    tokens_out = sum(r.tokens_out for r in results)
    print(f"\nOverall pass rate: {rate * 100:.0f}% (threshold {threshold * 100:.0f}%)")
    print(f"Tokens: {tokens_in} in / {tokens_out} out, est. cost ${estimate_cost(tokens_in, tokens_out):.4f}")
    print(f"Avg latency per case: {sum(r.latency_ms for r in results) // len(results)}ms")
    for r in results:
        if not r.passed:
            print(f"\n{r.id} [{r.tag}] failed checks:")
            for c in r.checks:
                if not c.passed:
                    print(f"  - {c.name}: {c.detail}")
    return rate


async def evaluate(url: str, key: str, threshold: float) -> int:
    llm = GeminiProvider(key, os.environ.get("GEMINI_MODEL", "gemini-3.5-flash"), "gemini-embedding-001")
    engine = create_engine(async_database_url(url))
    factory = create_session_factory(engine)
    cases = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]
    try:
        async with factory() as db:
            await db.execute(text(WIPE))
            await question_bank.seed(db)
            user = User(email="eval@vox.local", name="Vox Eval")
            db.add(user)
            await db.commit()
            user_id = user.id

        print(f"Running {len(cases)} eval cases (concurrency {CONCURRENCY}, threshold {threshold})...")
        gate = asyncio.Semaphore(CONCURRENCY)

        async def one(case: dict[str, Any]) -> CaseResult:
            async with gate:
                r = await run_case(case, factory, llm, user_id)
                print(f"  {r.id} ({r.tag}) {'PASS' if r.passed else 'FAIL'}")
                return r

        results = await asyncio.gather(*(one(c) for c in cases))
        rate = report(list(results), threshold)
        async with factory() as db:
            await db.execute(text(WIPE))
            await db.commit()
    finally:
        await engine.dispose()
    if rate < threshold:
        print(f"\nEval FAILED: pass rate {rate * 100:.0f}% < {threshold * 100:.0f}%")
        return 1
    return 0


def main() -> int:
    url = os.environ.get("TEST_DATABASE_URL")
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not url or not key:
        print("evals: TEST_DATABASE_URL and GEMINI_API_KEY are required (the eval runs the real model).")
        return 1
    # Only the dedicated test database, migrated like production (Alembic).
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_DIR,
        env={**os.environ, "DATABASE_URL": url},
        check=True,
    )
    return asyncio.run(evaluate(url, key, float(os.environ.get("EVAL_PASS_THRESHOLD", "0.9"))))


if __name__ == "__main__":
    sys.exit(main())
