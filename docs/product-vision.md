# Product vision: Vox, your AI hiring loop

Job → multi-round interviews → AI panel → evidence-backed practice verdict → personalized coaching → measured improvement.

Vox is a **practice** tool. It helps candidates rehearse a realistic hiring loop and see, with evidence from their own words, what to improve. It does not predict or influence real hiring decisions, and nothing it produces should be presented as one.

## Who it is for

| User | Core use cases |
|---|---|
| Job seekers (students, early-career, experienced engineers moving roles) | Rehearse a full loop for a target role and level; get per-round scores backed by quotes from their own answers; drill weak areas across sessions |
| Candidates interviewing in Indian languages | Run the loop in English, Hindi, Tamil or Telugu; technical scoring never depends on accent or fluency |
| Later: colleges and bootcamps (not in Phase 10) | Track cohort practice and improvement over time |

## The planned hiring simulation

A **loop** is an ordered list of **rounds**, like a real hiring process:

| Round | What it probes | Rubric (current) |
|---|---|---|
| Screening | Role fit, relevant experience | `screening-v1` |
| Technical fundamentals | Correctness, depth, application | `technical-v1` |
| Project deep-dive | Ownership, technical decisions, impact | `project-v1` |
| Behavioral | Situation and action, result and reflection | `behavioral-v1` |
| Managerial | People, prioritisation, accountability | `managerial-v1` |

Each round has a question count, a duration, a follow-up depth and a rubric version. Later phases add an AI panel (several reviewers per round), a practice verdict across rounds, coaching plans, and measured improvement between loops.

## Model decisions vs server permissions

The model is a capable but untrusted collaborator:

- **The model proposes:** how to phrase a question, which context tools to consult, whether an answer deserves a follow-up, per-criterion scores with quoted evidence.
- **The server decides:** the current state and every transition (`engine/machine.py`), which tools are allowed in that state, which question comes next, whether a follow-up fits the round's depth, whether each quote really appears in the candidate's persisted words, and the final score (a weighted mean computed by the server, never asserted by the model).
- **The server persists:** every transition, every transcript segment and every evaluation attempt, with the rubric, prompt and model versions that produced it.

If the model's output is invalid or cites words the candidate never said, the server rejects it and retries. If it still cannot get a valid evaluation, it records the failure and the candidate can retry, rather than accepting a guess.

## How Phase 10 supports what comes next

| Future phase | Builds on |
|---|---|
| AI panel | `answer_evaluations` already stores one row per attempt with model and prompt versions; several reviewers become several rows per answer |
| Practice verdict | Per-round scores computed from validated, versioned evaluations |
| Coaching | Missing concepts and improvements per answer, tied to rubric criteria |
| Measured improvement | Rubric versions make scores comparable across loops; the calibration runner measures agreement with human reviewers |
| College dashboards | Interviews, rounds and evaluations are user-scoped rows that can be aggregated with consent |

## Scope of Phase 10

In scope: the server-authoritative state machine, multi-round loops, versioned rubrics, evidence-backed scoring with abstention, extended reports, and a calibration foundation.

Out of scope (later phases): the AI panel, college dashboards, billing, coding interviews, and voice-specific evaluation (live voice keeps working, but its transcript comes through the model, so it is weaker evidence than typed or server-transcribed text).

## Known limitations

- Scores come from one model per answer. A valid quote proves the words were said, not that the score is right; agreement with human reviewers is measured only once human-reviewed examples exist (`services/api/evals/calibration`).
- No human-reviewed calibration set exists yet. The starter dataset is synthetic and labelled as such.
- Duration is configured per round but only reported, not enforced as a hard stop.
- Real-model evaluation has not been run (it is paid; see `docs/needs-human.md`).
