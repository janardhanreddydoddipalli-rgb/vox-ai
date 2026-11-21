"use client";

import { useState, useTransition } from "react";

type Memory = { id: string; kind: string; text: string; createdAt: string };

export default function SettingsClient({ initialMemories }: { initialMemories: Memory[] }) {
  const [memories, setMemories] = useState(initialMemories);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function remove(id: string) {
    setError(null);
    setDeletingId(id);
    try {
      const res = await fetch("/api/memories", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Delete failed (${res.status})`);
      }
      startTransition(() => setMemories((prev) => prev.filter((m) => m.id !== id)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  if (memories.length === 0) {
    return (
      <section className="card empty-state">
        <p>No memories yet. Finish an interview and Vox will remember your strengths, weaknesses and preferences here.</p>
      </section>
    );
  }

  return (
    <section>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <ul className="memory-list">
        {memories.map((m) => (
          <li key={m.id} className="card memory-item">
            <span className={`chip chip-${m.kind}`}>{m.kind}</span>
            <p className="memory-text">{m.text}</p>
            <time className="muted" dateTime={m.createdAt}>
              {new Date(m.createdAt).toLocaleDateString()}
            </time>
            <button
              type="button"
              className="btn-danger"
              onClick={() => remove(m.id)}
              disabled={deletingId === m.id}
              aria-label={`Delete memory: ${m.text}`}
            >
              {deletingId === m.id ? "Deleting…" : "Delete"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
