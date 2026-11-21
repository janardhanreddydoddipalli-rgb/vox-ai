"use client";

import { useState } from "react";
import Link from "next/link";

type Session = { id: string; mode: string; createdAt: string };
type Turn = { sessionId: string; role: string; text: string; latencyMs: number | null; createdAt: string };

export default function DashboardClient({ email, sessions, turns }: { email: string; sessions: Session[]; turns: Turn[] }) {
  const [count, setCount] = useState(sessions.length);
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

  return (
    <div className="dash">
      <h1>Your history</h1>
      <p className="muted">
        Signed in as {email} · {count} session{count === 1 ? "" : "s"}
      </p>

      {deleted && <p className="notice">All your sessions and turns were deleted.</p>}

      {sessions.length === 0 ? (
        <p className="empty">No sessions yet.</p>
      ) : (
        sessions.map((s) => (
          <section key={s.id} className="session">
            <h2>
              {s.id.slice(0, 12)}… · {s.mode} · {new Date(s.createdAt).toLocaleString()}
            </h2>
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
          </section>
        ))
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
        <Link href="/">← Back to Vox</Link> · <Link href="/privacy">Privacy</Link>
      </p>
    </div>
  );
}
