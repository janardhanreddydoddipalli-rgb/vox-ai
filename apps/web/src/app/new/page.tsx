"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { INTERVIEW_LANGUAGES, type LanguageCode } from "@/lib/languages";
import { apiFetch, problemDetail } from "@/lib/api-browser";

const ROLES = ["Frontend Engineer", "Backend Engineer", "Full-stack Engineer", "DSA / Coding", "HR / Behavioral"];
const LEVELS = [
  { value: "junior", label: "Junior", hint: "0–2 years" },
  { value: "mid", label: "Mid", hint: "2–5 years" },
  { value: "senior", label: "Senior", hint: "5+ years" },
] as const;

export default function NewInterviewPage() {
  const router = useRouter();
  const [role, setRole] = useState("");
  const [level, setLevel] = useState<"junior" | "mid" | "senior">("mid");
  const [language, setLanguage] = useState<LanguageCode>("en");
  const [jd, setJd] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [micState, setMicState] = useState<"idle" | "testing" | "ok" | "denied">("idle");
  const [micLevel, setMicLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  async function testMic() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicState("testing");
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        setMicLevel(Math.min(100, avg * 2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      // auto-stop after 3s
      setTimeout(() => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        setMicLevel(0);
        setMicState("ok");
      }, 3000);
    } catch {
      setMicState("denied");
      setError("Microphone blocked — you can still run a text-mode interview.");
    }
  }

  async function start() {
    setError("");
    if (!role.trim()) {
      setError("Pick a role to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("role", role.trim());
      form.set("level", level);
      form.set("language", language);
      if (jd.trim()) form.set("job_description", jd);
      if (file) form.set("resume", file);
      const res = await apiFetch("/v1/interviews", { method: "POST", body: form });
      if (res.status !== 201) throw new Error(await problemDetail(res, "Could not start the interview"));
      const data = (await res.json()) as { id: string };
      router.push(`/interview/${data.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the interview");
      setSubmitting(false);
    }
  }

  return (
    <main className="new-page">
      <h1>Set up your interview</h1>
      <p className="new-sub">Vox asks one question at a time, listens, and scores every answer.</p>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <section className="card">
        <h2>1. Role</h2>
        <div className="chips" role="radiogroup" aria-label="Role">
          {ROLES.map((r) => (
            <button key={r} className={`chip ${role === r ? "chip-active" : ""}`} role="radio" aria-checked={role === r} onClick={() => setRole(r)} type="button">
              {r}
            </button>
          ))}
        </div>

        <h2>2. Level</h2>
        <div className="chips" role="radiogroup" aria-label="Level">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              className={`chip ${level === l.value ? "chip-active" : ""}`}
              role="radio"
              aria-checked={level === l.value}
              onClick={() => setLevel(l.value)}
              type="button"
            >
              {l.label} <span className="chip-hint">{l.hint}</span>
            </button>
          ))}
        </div>

        <h2>3. Language</h2>
        <div className="chips" role="radiogroup" aria-label="Interview language">
          {INTERVIEW_LANGUAGES.map((l) => (
            <button
              key={l.code}
              className={`chip ${language === l.code ? "chip-active" : ""}`}
              role="radio"
              aria-checked={language === l.code}
              onClick={() => setLanguage(l.code)}
              type="button"
            >
              {l.label}
            </button>
          ))}
        </div>

        <h2>
          4. Resume <span className="chip-hint">(optional, PDF up to 5 MB)</span>
        </h2>
        <label className="file-label">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={submitting}
          />
          {file ? `Selected: ${file.name}` : "Choose a PDF — Vox will ask about your projects."}
        </label>

        <h2>
          5. Job description <span className="chip-hint">(optional, pasted text)</span>
        </h2>
        <textarea
          value={jd}
          onChange={(e) => setJd(e.target.value)}
          rows={4}
          maxLength={8000}
          placeholder="Paste the job posting here and the questions will lean on it."
          disabled={submitting}
        />

        <h2>6. Mic check</h2>
        {micState === "ok" ? (
          <p className="mic-ok">Mic works — you&apos;re set for voice mode.</p>
        ) : micState === "denied" ? (
          <p className="mic-denied">Mic blocked. Text mode still works.</p>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={testMic} disabled={micState === "testing"}>
            {micState === "testing" ? "Listening… speak now" : "Test my microphone"}
          </button>
        )}
        {micState === "testing" && (
          <div className="mic-meter" aria-hidden>
            <div style={{ width: `${micLevel}%` }} />
          </div>
        )}

        <button type="button" className="btn btn-primary btn-start" onClick={start} disabled={submitting}>
          {submitting ? "Starting…" : "Start interview"}
        </button>
      </section>
    </main>
  );
}
