"use client";

import { useState } from "react";
import Link from "next/link";

type Session = { id: string; mode: string; createdAt: string };
type Turn = { sessionId: string; role: string; text: string; latencyMs: number | null; createdAt: string };
type Interview = { id: string; role: string; level: string; status: string; overall: number | null; createdAt: string };
type QaScore = { interviewId: string; order: number; score: number | null; createdAt: string };

export default function DashboardClient({
  email,
  sessions,
  turns,
  interviews,
  qaScores,
}: {
  email: string;
  sessions: Session[];
  turns: Turn[];
  interviews: Interview[];
  qaScores: QaScore[];
}) {
  const [count, setCount] = useState(sessions.length + interviews.length);
  const [deleted, setDeleted] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const deleteMyData = async () => {
    const res = await fetch("/api/me/delete", { method: "DELETE" });
    if (res.ok) {
      setCount(0);
      setDeleted(true);
      setConfirming(false);
    }
  };

  // Score trend: chronological per-question scores, answered only.
  const scores = qaScores.filter((q) => q.score != null).map((q) => q.score!) ;
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const maxTrend = Math.max(10, ...scores);

  // Weakest topics: group answered questions by rough topic keyword in the
  // question text (interview_qa stores the question text on the interview side;
  // here we approximate by per-question score buckets).
  const weak = qaScores
    .map((q) => ({ ...q, score: q.score }))
    .filter((q) => q.score != null)
    .reduce<{ key: string; total: number; n: number }[]>((acc, q) => {
      // topics come from the interview Q&A the report stored; fall back to
      // per-question ordering
      const key = q.order < 3 ? `Question ${q.order + 1}` : "Later questions";
      const found = acc.find((a) => a.key === key);
      if (found) {
        found.total += q.score!;
        found.n += 1;
      } else {
        acc.push({ key, total: q.score!, n: 1 });
      }
      return acc;
    }, [])
    .map((a) => ({ topic: a.key, avg: a.total / a.n }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 3);

  return (
    <div className="dash">
      <h1>Your history</h1>
      <p className="muted">
        Signed in as {email} · {count} interview{count === 1 ? "" : "s"}
      </p>

      <p>
        <Link className="btn btn-primary" href="/new">
          Start a new interview
        </Link>
      </p>

      {deleted && <p className="notice">All your sessions and turns were deleted.</p>}

      {interviews.length === 0 ? (
        <div className="empty-state">
          <p className="empty">No interviews yet.</p>
          <p className="muted">
            Pick a role and level on the <Link href="/new">new interview</Link> page and Vox will run you through three
            questions with spoken feedback and a scored report.
          </p>
        </div>
      ) : (
        <>
          <section className="card trend-card" aria-label="Score trend">
            <h2>Score trend</h2>
            {avg != null ? (
              <>
                <p className="muted tabular">
                  Average {avg.toFixed(1)} / 10 across {scores.length} answered question{scores.length === 1 ? "" : "s"}
                </p>
                <svg className="trend-svg" viewBox="0 0 300 80" role="img" aria-label="Per-question score trend">
                  {scores.map((s, i) => {
                    const x = scores.length === 1 ? 150 : 10 + (i * 280) / (scores.length - 1);
                    const y = 75 - (s / maxTrend) * 65;
                    return (
                      <g key={i}>
                        <circle cx={x} cy={y} r={3} className="trend-dot" />
                        {i > 0 && (
                          <line
                            x1={10 + ((i - 1) * 280) / (scores.length - 1)}
                            y1={75 - (scores[i - 1] / maxTrend) * 65}
                            x2={x}
                            y2={y}
                            className="trend-line"
                          />
                        )}
                      </g>
                    );
                  })}
                </svg>
              </>
            ) : (
              <p className="empty-note">Finish an interview to see your score trend.</p>
            )}
            {weak.length > 0 && (
              <div className="weak-topics">
                <h3>Weakest questions</h3>
                <ul>
                  {weak.map((w) => (
                    <li key={w.topic} className="tabular">
                      {w.topic} — avg {w.avg.toFixed(1)}/10
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section aria-label="Past interviews">
            <h2>Past interviews</h2>
            {interviews.map((iv) => (
              <div key={iv.id} className="interview-row">
                <div>
                  <strong>{iv.role}</strong> · {iv.level} · {new Date(iv.createdAt).toLocaleDateString()}
                </div>
                <div className="interview-row-actions">
                  {iv.overall != null && (
                    <span className="score-chip tabular">{iv.overall.toFixed(1)}/10</span>
                  )}
                  {iv.status === "complete" ? (
                    <Link className="btn" href={`/interviews/${iv.id}/report`}>
                      Report
                    </Link>
                  ) : (
                    <Link className="btn" href={`/interview/${iv.id}`}>
                      Resume
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </section>
        </>
      )}

      {sessions.length > 0 && (
        <section aria-label="Voice sessions">
          <h2>Voice sessions</h2>
          {sessions.map((s) => (
            <div key={s.id} className="session">
              <h3>
                {s.id.slice(0, 12)}… · {s.mode} · {new Date(s.createdAt).toLocaleString()}
              </h3>
              <ul>
                {turns
                  .filter((t) => t.sessionId === s.id)
                  .map((t, i) => (
                    <li key={i}>
                      <strong>{t.role === "user" ? "You" : "Vox"}:</strong> {t.text}
                      {t.latencyMs != null && <span className="muted"> ({t.latencyMs} ms)</span>}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {confirming ? (
        <div>
          <p>This permanently deletes your account, all sessions and all turns. This cannot be undone.</p>
          <button className="btn danger" onClick={deleteMyData}>
            Yes, delete everything
          </button>{" "}
          <button className="btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn danger" onClick={() => setConfirming(true)} disabled={deleted || count === 0}>
          Delete my data
        </button>
      )}

      <p>
        <Link href="/">← Back to Vox</Link> · <Link href="/settings">Memory settings</Link> ·{" "}
        <Link href="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
