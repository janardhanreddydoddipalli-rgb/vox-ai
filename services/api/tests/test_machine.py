"""The state machine: every (state, action) pair, every guard, every allowlist."""

import itertools

import pytest

from vox_api.agent.tools.registry import TOOLS
from vox_api.engine.machine import (
    TERMINAL,
    TOOL_ALLOWLIST,
    WORKING,
    Action,
    InvalidTransitionError,
    Progress,
    State,
    allowed_tools,
    transition,
)

S, A = State, Action
# Progress under which every guard passes for the action being tested.
OPEN = {
    A.FOLLOW_UP: Progress(follow_ups_used=0, follow_up_depth=1),
    A.CONTINUE: Progress(questions_asked=1, question_count=3),
    A.FINISH_ROUND: Progress(questions_asked=3, question_count=3),
    A.NEXT_ROUND: Progress(has_next_round=True),
    A.FINISH_LOOP: Progress(has_next_round=False),
}

# The complete allowed table, written out independently of the implementation.
EXPECTED: dict[tuple[State, Action], State] = {
    (S.INTRO, A.START): S.ASKING,
    (S.ASKING, A.ASK): S.AWAITING_ANSWER,
    (S.AWAITING_ANSWER, A.ANSWER): S.EVALUATING,
    (S.EVALUATING, A.FOLLOW_UP): S.FOLLOW_UP,
    (S.EVALUATING, A.NEXT): S.NEXT_QUESTION,
    (S.FOLLOW_UP, A.ASK_FOLLOW_UP): S.AWAITING_ANSWER,
    (S.NEXT_QUESTION, A.CONTINUE): S.ASKING,
    (S.NEXT_QUESTION, A.FINISH_ROUND): S.ROUND_COMPLETE,
    (S.ROUND_COMPLETE, A.NEXT_ROUND): S.ASKING,
    (S.ROUND_COMPLETE, A.FINISH_LOOP): S.LOOP_COMPLETE,
    **{(s, A.FAIL): S.FAILED for s in (S.ASKING, S.EVALUATING, S.FOLLOW_UP)},
    **{(s, A.END_EARLY): S.LOOP_COMPLETE for s in State if s not in (S.LOOP_COMPLETE, S.CANCELLED)},
    **{(s, A.CANCEL): S.CANCELLED for s in State if s not in (S.LOOP_COMPLETE, S.CANCELLED)},
}


@pytest.mark.parametrize(("state", "action"), list(itertools.product(State, Action)))
def test_every_state_action_pair(state: State, action: Action) -> None:
    progress = OPEN.get(action, Progress())
    if action is A.RETRY:
        if state is S.FAILED:
            for origin in WORKING:
                assert transition(state, action, Progress(failed_from=origin)) is origin
        else:
            with pytest.raises(InvalidTransitionError):
                transition(state, action, Progress(failed_from=S.EVALUATING))
        return
    if (state, action) in EXPECTED:
        assert transition(state, action, progress) is EXPECTED[(state, action)]
    else:
        with pytest.raises(InvalidTransitionError):
            transition(state, action, progress)


def test_terminal_states_accept_nothing() -> None:
    assert frozenset({S.LOOP_COMPLETE, S.CANCELLED}) == TERMINAL
    for state, action in itertools.product(TERMINAL, Action):
        with pytest.raises(InvalidTransitionError, match="over"):
            transition(state, action, OPEN.get(action, Progress(failed_from=S.EVALUATING)))


@pytest.mark.parametrize(
    ("state", "action", "progress", "reason"),
    [
        (S.EVALUATING, A.FOLLOW_UP, Progress(follow_ups_used=1, follow_up_depth=1), "depth"),
        (S.EVALUATING, A.FOLLOW_UP, Progress(follow_ups_used=0, follow_up_depth=0), "depth"),
        (S.NEXT_QUESTION, A.CONTINUE, Progress(questions_asked=3, question_count=3), "no questions left"),
        (
            S.NEXT_QUESTION,
            A.FINISH_ROUND,
            Progress(questions_asked=2, question_count=3),
            "still has questions",
        ),
        (S.ROUND_COMPLETE, A.NEXT_ROUND, Progress(has_next_round=False), "last round"),
        (S.ROUND_COMPLETE, A.FINISH_LOOP, Progress(has_next_round=True), "rounds remain"),
        (S.FAILED, A.RETRY, Progress(failed_from=None), "nothing to retry"),
        (S.FAILED, A.RETRY, Progress(failed_from=S.AWAITING_ANSWER), "nothing to retry"),
        (S.AWAITING_ANSWER, A.FAIL, Progress(), "only a running operation"),
    ],
)
def test_guards_reject_moves_the_round_does_not_permit(
    state: State, action: Action, progress: Progress, reason: str
) -> None:
    with pytest.raises(InvalidTransitionError, match=reason):
        transition(state, action, progress)


def test_a_model_proposal_cannot_skip_states() -> None:
    """The evaluator can propose a follow-up; nothing lets it jump to the end or past a question."""
    for action in (A.FINISH_LOOP, A.FINISH_ROUND, A.ASK, A.CONTINUE):
        with pytest.raises(InvalidTransitionError):
            transition(S.EVALUATING, action, OPEN.get(action, Progress()))


def test_every_state_has_an_allowlist_of_real_tools() -> None:
    registry = {t.name for t in TOOLS}
    assert set(TOOL_ALLOWLIST) == set(State)
    for state in State:
        assert allowed_tools(state) <= registry


def test_scoring_and_question_tools_are_confined_to_their_states() -> None:
    assert {s for s in State if "evaluate_answer" in allowed_tools(s)} == {S.EVALUATING}
    assert {s for s in State if "get_question" in allowed_tools(s)} == {S.ASKING}
    assert all(not allowed_tools(s) for s in (*TERMINAL, S.FAILED, S.AWAITING_ANSWER))
    assert not any("end_interview" in allowed_tools(s) for s in State)  # ending is the candidate's call
