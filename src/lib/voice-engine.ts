"use client";

// Voice engine: speech in and out via the browser's Web Speech API
// (SpeechRecognition + speechSynthesis), replies generated server-side by
// Gemini Flash when GEMINI_API_KEY is configured, local fallback otherwise.

export type Turn = { role: "user" | "assistant"; text: string; latencyMs?: number };
export type VoiceMode = "gemini" | "browser";
type Status = "idle" | "listening" | "thinking" | "speaking";

type Handlers = {
  onStatus: (s: Status) => void;
  onTurn: (t: Turn) => void;
  onPartial: (text: string) => void;
  onError: (msg: string) => void;
  onMode: (m: VoiceMode) => void;
  onLevel: (v: number) => void;
};

export class VoiceEngine {
  private h: Handlers;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private recognition: any = null;
  private mode: VoiceMode = "browser";
  private history: { role: "user" | "assistant"; text: string }[] = [];

  constructor(handlers: Handlers) {
    this.h = handlers;
  }

  get voiceMode() {
    return this.mode;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.measureLevel();
    const engine = await this.fetchEngine();
    this.mode = engine === "gemini" ? "gemini" : "browser";
    this.startBrowser();
    this.h.onMode(this.mode);
  }

  private async fetchEngine(): Promise<string | null> {
    try {
      const res = await fetch("/api/chat");
      if (!res.ok) return null;
      const data = await res.json();
      return data.engine ?? null;
    } catch {
      return null;
    }
  }

  private startBrowser() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      this.h.onError("This browser has no Web Speech API. Chrome or Edge on desktop/Android is required.");
      return;
    }
    const rec = new SR();
    this.recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            this.h.onTurn({ role: "user", text });
            this.speak(text);
          }
        } else interim += r[0].transcript;
      }
      this.h.onPartial(interim);
    };
    rec.onerror = (e: any) => {
      if (e.error !== "no-speech") this.h.onError(`Speech recognition: ${e.error}`);
    };
    rec.onend = () => {
      if (this.recognition) {
        try {
          this.recognition.start();
        } catch {
          /* restarting */
        }
      }
    };
    rec.start();
    this.h.onStatus("listening");
  }

  private speak(text: string) {
    this.h.onStatus("thinking");
    const started = Date.now();
    const synth = window.speechSynthesis;
    if (!synth) {
      this.h.onStatus("listening");
      return;
    }
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userText: text, history: this.history }),
    })
      .then((r) => r.json())
      .then((d) => (d.reply as string) || "Sorry, I had trouble responding.")
      .catch(() => "Sorry, I had trouble responding.")
      .then((reply) => {
        this.history.push({ role: "user", text }, { role: "assistant", text: reply });
        if (this.history.length > 16) this.history = this.history.slice(-16);
        const u = new SpeechSynthesisUtterance(reply);
        u.rate = 1.05;
        u.onstart = () => this.h.onStatus("speaking");
        u.onend = () => this.h.onStatus("listening");
        this.h.onTurn({ role: "assistant", text: reply, latencyMs: Date.now() - started });
        synth.speak(u);
      });
  }

  private measureLevel() {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const src = ctx.createMediaStreamSource(this.stream!);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    this.analyser = analyser;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      this.h.onLevel(Math.sqrt(sum / buf.length) / 255);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.stop();
      } catch {}
    }
    this.analyser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    window.speechSynthesis?.cancel();
    this.h.onStatus("idle");
  }
}
