"""The bounded function-calling loop (port of apps/web agent/loop.ts).

At most MAX_TOOL_STEPS tool rounds per user turn; then one call without tools
forces a spoken reply. Every tool call is validated, run in its own savepoint
(a failing tool can't poison the turn's transaction) and traced to agent_steps.
"""

import time
from collections.abc import AsyncGenerator, Sequence
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from vox_api.agent.tools.base import ToolContext
from vox_api.agent.tools.registry import get_tool, tool_specs
from vox_api.llm.base import Message, Turn
from vox_api.models import AgentStep
from vox_api.services.chat import sentences

MAX_TOOL_STEPS = 5


@dataclass
class Step:
    step_index: int
    tool_name: str
    input: dict[str, Any]
    output: dict[str, Any]
    duration_ms: int


@dataclass
class LoopResult:
    reply: str = ""
    steps: list[Step] = field(default_factory=list)
    hit_step_limit: bool = False
    tokens_in: int = 0
    tokens_out: int = 0


def _invalid(name: str, exc: ValidationError) -> dict[str, Any]:
    issues = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())
    return {"error": f"Invalid arguments for {name}: {issues}"}


async def run_tool(name: str, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """Validate and run one tool call; failures come back as {"error": ...} for the model."""
    tool = get_tool(name)
    if tool is None:
        return {"error": f"Unknown tool: {name}"}
    try:
        parsed = tool.input_model.model_validate(args)
    except ValidationError as exc:
        return _invalid(name, exc)
    try:
        async with ctx.db.begin_nested():
            return await tool.handler(parsed, ctx)
    except Exception as exc:  # any tool failure goes back to the model; the savepoint undid its writes
        return {"error": f"Tool {name} failed: {type(exc).__name__}: {exc}"[:500]}


async def run(
    ctx: ToolContext,
    history: Sequence[Message],
    user_text: str,
    system: str,
    result: LoopResult,
) -> AsyncGenerator[tuple[str, str]]:
    """Yields ("token" | "sentence", text) for the spoken reply; fills `result`."""
    conversation: list[Message | Turn] = [*history, Message("user", user_text)]
    specs = tool_specs()

    for _ in range(MAX_TOOL_STEPS):
        turn = await ctx.llm.generate_turn(
            conversation, system=system, tools=specs, temperature=0.6, max_output_tokens=1024
        )
        result.tokens_in += turn.tokens_in
        result.tokens_out += turn.tokens_out
        if not turn.calls:
            result.reply = turn.text
            if turn.text:
                for s in sentences(turn.text) or [turn.text]:
                    if s.strip():
                        yield "sentence", s.strip()
                yield "token", turn.text
            return

        outputs: list[tuple[str, Any]] = []
        for call in turn.calls:
            started = time.monotonic()
            output = await run_tool(call.name, call.args, ctx)
            step = Step(
                len(result.steps), call.name, call.args, output, round((time.monotonic() - started) * 1000)
            )
            result.steps.append(step)
            if ctx.interview is not None:
                async with ctx.db.begin_nested():
                    ctx.db.add(
                        AgentStep(
                            interview_id=ctx.interview.id,
                            step_index=step.step_index,
                            tool_name=step.tool_name,
                            input=step.input,
                            output=step.output,
                            duration_ms=step.duration_ms,
                        )
                    )
            outputs.append((call.name, output or {"ok": True}))
        conversation.append(Turn("model", calls=tuple(turn.calls)))
        conversation.append(Turn("user", results=tuple(outputs)))

    # Step limit reached: one call with no tools, so the model must speak.
    result.hit_step_limit = True
    carry = ""
    async with aclosing(
        ctx.llm.stream(conversation, system=system, temperature=0.6, max_output_tokens=1024)
    ) as stream:
        async for chunk in stream:
            result.tokens_in += chunk.tokens_in
            result.tokens_out += chunk.tokens_out
            if not chunk.text:
                continue
            result.reply += chunk.text
            yield "token", chunk.text
            carry += chunk.text
            parts = sentences(carry)
            carry = parts.pop() if parts else ""
            for s in parts:
                yield "sentence", s.strip()
    if carry.strip():
        yield "sentence", carry.strip()
    result.reply = result.reply.strip()
