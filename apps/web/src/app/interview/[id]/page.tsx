"use client";

import { useCallback, useEffect, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { VoiceEngine, type Turn } from "@/voice/engine";

type InterviewInfo = {
  id: string;
  role: string;
  level: string;
  status: string;
  questionCount: number;
  hasResume: boolean;
  language?: string;
  error?: string;
};

const TARGET_QUESTIONS = 3;

export default function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { id } = use(params);
  return <InterviewClient interviewId={id} router={router} />;
}
function InterviewClient({ interviewId, router }: { interviewId: string; router: ReturnType<typeof useRouter> }) {
  const [info, setInfo] = useState<InterviewInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState("");
  const [replyPartial, setReplyPartial] = useState("");
  const [status, setStatus] = useState<"idle" | "listening" | "thinking" | "speaking">("idle");
  const [questionCount, setQuestionCount] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState("");
  const [textDraft, setTextDraft] = useState("");
  const engineRef = useRef<VoiceEngine | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/interviews/${interviewId}`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data: InterviewInfo = await res.json();
      setInfo(data);
      setQuestionCount(data.questionCount);
      return data;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load interview");
      return null;
    }
  }, [interviewId]);

  // Initial load, timer and question-count poll while active.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    const poll = setInterval(() => void refresh(), 8000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
      clearInterval(poll);
    };
  }, [refresh]);

  // Voice engine once the interview is confirmed to exist.
  useEffect(() => {
    if (!info || engineRef.current) return;
    const engine = new VoiceEngine({
      onStatus: setStatus,
      onTurn: (t) => {
        setTurns((prev) => [...prev, t]);
        setPartial("");
        if (t.role === "assistant") setReplyPartial("");
      },
      onPartial: setPartial,
      onReplyPartial: setReplyPartial,
      onError: (m) => console.warn("voice:", m),
      onMode: () => {},
      onLevel: () => {},
      onOffline: () => {},
      onFallback: (from, to, reason) => console.warn(`voice fallback ${from} → ${to}: ${reason}`),
    });
    engine.interviewId = interviewId;
    engine.language = info.language ?? "en";
    engineRef.current = engine;
    engine.start().catch(() => {
      // mic unavailable — text mode still works
    });
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, [info, interviewId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns, partial, replyPartial]);

  async function endInterview() {
    setEnding(true);
    setEndError("");
    engineRef.current?.stop();
    try {
      const res = await fetch(`/api/interviews/${interviewId}/end`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not end the interview");
      router.push(`/interviews/${interviewId}/report`);
    } catch (e) {
      setEndError(e instanceof Error ? e.message : "Could not end the interview");
      setEnding(false);
    }
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const currentQuestion = lastAssistant && !replyPartial ? lastAssistant.text : replyPartial || lastAssistant?.text || "";

  if (loadError) {
    return (
      <main className="interview-page">
        <div className="card state-card">
          <h1>Interview unavailable</h1>
          <p>{loadError}</p>
          <Link className="btn btn-primary" href="/new">Start a new interview</Link>
        </div>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="interview-page">
        <div className="skeleton skeleton-question" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line short" />
      </main>
    );
  }

  return (
    <main className="interview-page">
      <header className="interview-top">
        <div className="interview-meta">
          <span className="pill">{info.role} · {info.level}</span>
          <span className="pill" aria-label={`Question ${questionCount + 1}`}>
            Q{questionCount + 1}/{TARGET_QUESTIONS}
          </span>
          <span className="pill tabular" aria-label="Elapsed time">{mm}:{ss}</span>
          <span className={`pill ${status === "speaking" ? "pill-accent" : ""}`}>{status}</span>
        </div>
        <button className="btn btn-danger" onClick={endInterview} disabled={ending}>
          {ending ? "Writing report…" : "End interview"}
        </button>
      </header>
      {endError && <div className="form-error" role="alert">{endError}</div>}

      <section className="current-question" aria-live="polite">
        <h2>Current question</h2>
        <p>{currentQuestion || "Vox is preparing your first question…"}</p>
      </section>

      <div className="transcript" ref={transcriptRef}>
        {turns.length === 0 && <p className="empty-note">Your answers appear here and are saved after each reply.</p>}
        {turns.map((t, i) => (
          <div key={i} className={`turn turn-${t.role}`}>
            <span className="turn-role">{t.role === "user" ? "You" : "Vox"}</span>
            <p>{t.text}</p>
          </div>
        ))}
        {partial && (
          <div className="turn turn-user turn-partial">
            <span className="turn-role">You</span>
            <p>{partial}▌</p>
          </div>
        )}
        {replyPartial && (
          <div className="turn turn-assistant turn-partial">
            <span className="turn-role">Vox</span>
            <p>{replyPartial}▌</p>
          </div>
        )}
      </div>

      <form
        className="textbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (!textDraft.trim()) return;
          engineRef.current?.sendText(textDraft.trim());
          setTextDraft("");
        }}
      >
        <input
          value={textDraft}
          onChange={(e) => setTextDraft(e.target.value)}
          placeholder="Type your answer (works without a mic)…"
          aria-label="Type your answer"
          disabled={ending}
        />
        <button className="btn btn-primary" type="submit" disabled={ending || !textDraft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
