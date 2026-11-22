"""The interview state machine: states, actions, transitions, guards and tool allowlists.

Pure and side-effect free. The engine (services/engine.py) persists every
transition; this module only answers "is this move allowed, and where does it go?".
A model may *propose* an action (e.g. a follow-up); the server applies it only
when `transition()` accepts it.
"""

from dataclasses import dataclass
from enum import StrEnum


class State(StrEnum):
    INTRO = "INTRO"
    ASKING = "ASKING"
    AWAITING_ANSWER = "AWAITING_ANSWER"
    EVALUATING = "EVALUATING"
    FOLLOW_UP = "FOLLOW_UP"
    NEXT_QUESTION = "NEXT_QUESTION"
    ROUND_COMPLETE = "ROUND_COMPLETE"
    LOOP_COMPLETE = "LOOP_COMPLETE"
    # Recovery and terminal states.
    FAILED = "FAILED"  # an operation failed; `retry` returns to the state it failed in
    CANCELLED = "CANCELLED"


class Action(StrEnum):
    START = "start"  # INTRO → ASKING (first round begins)
    ASK = "ask"  # ASKING → AWAITING_ANSWER (a question was chosen and put to the candidate)
    ANSWER = "answer"  # AWAITING_ANSWER → EVALUATING (the answer is recorded)
    FOLLOW_UP = "follow_up"  # EVALUATING → FOLLOW_UP (proposed by the evaluator, depth permitting)
    NEXT = "next"  # EVALUATING → NEXT_QUESTION
    ASK_FOLLOW_UP = "ask_follow_up"  # FOLLOW_UP → AWAITING_ANSWER
    CONTINUE = "continue"  # NEXT_QUESTION → ASKING (questions remain in the round)
    FINISH_ROUND = "finish_round"  # NEXT_QUESTION → ROUND_COMPLETE
    NEXT_ROUND = "next_round"  # ROUND_COMPLETE → ASKING (another round follows)
    FINISH_LOOP = "finish_loop"  # ROUND_COMPLETE → LOOP_COMPLETE
    FAIL = "fail"  # a working state → FAILED
    RETRY = "retry"  # FAILED → the state it failed in
    END_EARLY = "end_early"  # candidate ends now: → LOOP_COMPLETE with what was answered
    CANCEL = "cancel"  # → CANCELLED, no report


TERMINAL: frozenset[State] = frozenset({State.LOOP_COMPLETE, State.CANCELLED})
# States where an operation runs and can fail (and so be retried).
WORKING: frozenset[State] = frozenset({State.ASKING, State.EVALUATING, State.FOLLOW_UP})
# States the engine waits in for the candidate. Everything else is advanced by the server.
WAITING: frozenset[State] = frozenset({State.INTRO, State.AWAITING_ANSWER, State.FAILED})

_FIXED: dict[tuple[State, Action], State] = {
    (State.INTRO, Action.START): State.ASKING,
    (State.ASKING, Action.ASK): State.AWAITING_ANSWER,
    (State.AWAITING_ANSWER, Action.ANSWER): State.EVALUATING,
    (State.EVALUATING, Action.FOLLOW_UP): State.FOLLOW_UP,
    (State.EVALUATING, Action.NEXT): State.NEXT_QUESTION,
    (State.FOLLOW_UP, Action.ASK_FOLLOW_UP): State.AWAITING_ANSWER,
    (State.NEXT_QUESTION, Action.CONTINUE): State.ASKING,
    (State.NEXT_QUESTION, Action.FINISH_ROUND): State.ROUND_COMPLETE,
    (State.ROUND_COMPLETE, Action.NEXT_ROUND): State.ASKING,
    (State.ROUND_COMPLETE, Action.FINISH_LOOP): State.LOOP_COMPLETE,
}

# Tools a model may call in each state (the text phrasing loop and the live-voice
# bridge both offer and accept only these). get_question and evaluate_answer are
# the server's own steps in ASKING and EVALUATING.
TOOL_ALLOWLIST: dict[State, frozenset[str]] = {
    State.INTRO: frozenset({"recall_memories"}),
    State.ASKING: frozenset({"get_question", "read_resume", "search_documents", "recall_memories"}),
    State.AWAITING_ANSWER: frozenset(),
    State.EVALUATING: frozenset({"evaluate_answer", "search_documents"}),
    State.FOLLOW_UP: frozenset({"read_resume", "search_documents"}),
    State.NEXT_QUESTION: frozenset(),
    State.ROUND_COMPLETE: frozenset(),
    State.LOOP_COMPLETE: frozenset(),
    State.FAILED: frozenset(),
    State.CANCELLED: frozenset(),
}


@dataclass(frozen=True)
class Progress:
    """What the guards need to know about the current round and the loop."""

    questions_asked: int = 0
    question_count: int = 1
    follow_ups_used: int = 0
    follow_up_depth: int = 0
    has_next_round: bool = False
    failed_from: State | None = None


class InvalidTransitionError(Exception):
    def __init__(self, state: State, action: Action, reason: str) -> None:
        super().__init__(f"{action.value} is not allowed in {state.value}: {reason}")
        self.state = state
        self.action = action
        self.reason = reason


def transition(state: State, action: Action, progress: Progress) -> State:
    """The next state, or InvalidTransitionError. Guards check the round's limits."""
    if state in TERMINAL:
        raise InvalidTransitionError(state, action, "the interview is over")
    if action is Action.CANCEL:
        return State.CANCELLED
    if action is Action.END_EARLY:
        return State.LOOP_COMPLETE
    if action is Action.FAIL:
        if state not in WORKING:
            raise InvalidTransitionError(state, action, "only a running operation can fail")
        return State.FAILED
    if action is Action.RETRY:
        if state is not State.FAILED or progress.failed_from not in WORKING:
            raise InvalidTransitionError(state, action, "nothing to retry")
        return progress.failed_from

    target = _FIXED.get((state, action))
    if target is None:
        raise InvalidTransitionError(state, action, "no such transition")
    if action is Action.FOLLOW_UP and progress.follow_ups_used >= progress.follow_up_depth:
        raise InvalidTransitionError(state, action, "follow-up depth reached for this question")
    if action is Action.CONTINUE and progress.questions_asked >= progress.question_count:
        raise InvalidTransitionError(state, action, "the round has no questions left")
    if action is Action.FINISH_ROUND and progress.questions_asked < progress.question_count:
        raise InvalidTransitionError(state, action, "the round still has questions")
    if action is Action.NEXT_ROUND and not progress.has_next_round:
        raise InvalidTransitionError(state, action, "this is the last round")
    if action is Action.FINISH_LOOP and progress.has_next_round:
        raise InvalidTransitionError(state, action, "rounds remain")
    return target


def allowed_tools(state: State) -> frozenset[str]:
    return TOOL_ALLOWLIST[state]
