"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceEngine, type Turn, type VoiceMode } from "@/lib/voice-engine";

type Status = "idle" | "listening" | "thinking" | "speaking";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function sessionId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const engine = useRef<VoiceEngine | null>(null);
  const sid = useRef(sessionId());
  const saved = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [turns, partial]);

  useEffect(() => {
    if (status !== "idle" && !error) {
      const t = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(t);
    }
  }, [status, error]);

  useEffect(() => {
    return () => engine.current?.stop();
  }, []);

  const flush = useCallback((extra?: Turn) => {
    const all = extra ? [...turnsRef.current, extra] : [...turnsRef.current];
    if (all.length === saved.current) return;
    fetch("/api/turns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid.current, mode: modeRef.current ?? "browser", turns: all.slice(saved.current) }),
    })
      .then(() => (saved.current = all.length))
      .catch(() => {});
  }, [mode]);

  // keep a ref so flush sees latest turns without re-binding
  const turnsRef = useRef(turns);
  const partialRef = useRef(partial);
  const modeRef = useRef(mode);
  useEffect(() => {
    turnsRef.current = turns;
    partialRef.current = partial;
    modeRef.current = mode;
    if (turns.length >= 2 && turns.length % 2 === 0) flush();
  }, [turns, partial, mode, flush]);

  // Page closing: flush unsaved turns (including a partial in-flight turn)
  // via sendBeacon, which survives unload where fetch may not.
  useEffect(() => {
    const onPageHide = () => {
      const all = [...turnsRef.current];
      const partialText = partialRef.current.trim();
      if (partialText) all.push({ role: "user", text: partialText });
      const unsaved = all.slice(saved.current);
      if (unsaved.length === 0) return;
      const payload = JSON.stringify({
        sessionId: sid.current,
        mode: modeRef.current ?? "browser",
        turns: unsaved,
      });
      navigator.sendBeacon?.("/api/turns", new Blob([payload], { type: "application/json" }));
      saved.current = all.length;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const start = async () => {
    setError("");
    saved.current = 0;
    sid.current = sessionId();
    setTurns([]);
    setPartial("");
    engine.current = new VoiceEngine({
      onStatus: setStatus,
      onTurn: (t) => {
        setTurns((prev) => [...prev, t]);
        setPartial("");
      },
      onPartial: setPartial,
      onError: (m) => setError(m),
      onMode: setMode,
      onLevel: setLevel,
    });
    try {
      await engine.current.start();
    } catch (e: any) {
      setError(e?.message?.includes("Permission") || e?.name === "NotAllowedError"
        ? "Microphone access was denied. Allow the mic in your browser and try again."
        : `Could not start: ${e?.message ?? e}`);
      engine.current.stop();
      setStatus("idle");
    }
  };

  const stop = () => {
    flush();
    engine.current?.stop();
    engine.current = null;
    setPartial("");
    setStatus("idle");
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const active = status !== "idle";
  const bars = 5;

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <span className="dot" style={{ background: active ? "var(--accent)" : "var(--muted)" }} />
          Vox
        </div>
        <div className="meta">
          {mode && <span className="pill">{mode === "gemini" ? "Gemini · Flash" : "Browser speech"}</span>}
          {active && <span className="pill">{mm}:{ss}</span>}
        </div>
      </header>

      <section className="stage" aria-live="polite">
        <div className="orb" data-status={status} style={{ transform: `scale(${1 + level * 0.35})` }}>
          {Array.from({ length: bars }).map((_, i) => (
            <span
              key={i}
              className="bar"
              style={{
                height: `${Math.min(64, 8 + level * (status === "idle" ? 0 : 220) * (1 - Math.abs(i - 2) / 4))}px`,
              }}
            />
          ))}
        </div>
        <p className="status">{STATUS_LABEL[status]}</p>
      </section>

      <div className="controls">
        {!active ? (
          <button className="btn primary" onClick={start}>
            Start talking
          </button>
        ) : (
          <button className="btn danger" onClick={stop}>
            Stop
          </button>
        )}
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="log" ref={logRef}>
        {turns.length === 0 && !partial && (
          <p className="empty">
            Nothing yet. Tap <strong>Start talking</strong>, allow the microphone, and speak — your
            transcript appears here and is saved when you stop.
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            <span className="who">{t.role === "user" ? "You" : "Vox"}</span>
            <p>{t.text}</p>
            {t.latencyMs != null && <span className="latency">{t.latencyMs} ms</span>}
          </div>
        ))}
        {partial && (
          <div className="turn user pending">
            <span className="who">You</span>
            <p>{partial}</p>
          </div>
        )}
      </section>

      <style jsx global>{`
        .shell {
          max-width: 720px;
          margin: 0 auto;
          padding: 16px 16px 48px;
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-top: 8px;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 18px;
          letter-spacing: -0.02em;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .meta {
          display: flex;
          gap: 8px;
        }
        .pill {
          font-size: 12px;
          color: var(--muted);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 4px 10px;
          font-variant-numeric: tabular-nums;
        }
        .stage {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          padding: 36px 0 20px;
        }
        .orb {
          width: 120px;
          height: 120px;
          border-radius: 50%;
          background: var(--accent-dim);
          border: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          transition: transform 120ms ease-out, box-shadow 240ms ease-out;
          box-shadow: var(--shadow-1);
        }
        .orb[data-status="speaking"],
        .orb[data-status="listening"] {
          box-shadow: 0 0 40px var(--accent-dim);
        }
        .bar {
          width: 5px;
          min-height: 8px;
          border-radius: 3px;
          background: var(--accent);
          transition: height 100ms ease-out;
        }
        .status {
          margin: 0;
          color: var(--muted);
          font-size: 14px;
        }
        .controls {
          display: flex;
          justify-content: center;
        }
        .btn {
          min-height: 44px;
          min-width: 180px;
          padding: 12px 28px;
          border-radius: var(--radius);
          border: 1px solid transparent;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 120ms ease-out, opacity 120ms ease-out;
        }
        .btn:hover {
          transform: translateY(-1px);
        }
        .btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 3px;
        }
        .btn:active {
          transform: translateY(0) scale(0.98);
        }
        .primary {
          background: var(--accent);
          color: #08281e;
        }
        .danger {
          background: var(--surface-2);
          color: var(--danger);
          border-color: var(--border);
        }
        .error {
          margin: 0;
          padding: 12px 16px;
          border-radius: var(--radius);
          background: rgba(240, 113, 108, 0.12);
          border: 1px solid rgba(240, 113, 108, 0.4);
          color: var(--danger);
          font-size: 14px;
        }
        .log {
          flex: 1;
          overflow-y: auto;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 16px;
          box-shadow: var(--shadow-1);
          max-height: 45dvh;
        }
        .empty {
          color: var(--muted);
          font-size: 14px;
          line-height: 1.6;
          margin: 0;
        }
        .turn {
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
        }
        .turn:last-child {
          border-bottom: none;
        }
        .who {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--muted);
        }
        .turn p {
          margin: 4px 0 0;
          line-height: 1.5;
          font-size: 15px;
          max-width: 65ch;
        }
        .turn.assistant p {
          color: var(--text);
        }
        .turn.user p {
          color: var(--muted);
        }
        .pending p {
          opacity: 0.6;
        }
        .latency {
          font-size: 11px;
          color: var(--muted);
          font-variant-numeric: tabular-nums;
        }
        @media (prefers-reduced-motion: reduce) {
          * {
            transition: none !important;
          }
        }
      `}</style>
    </main>
  );
}
