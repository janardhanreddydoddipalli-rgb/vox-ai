"use client";

// Voice engine: speech in and out via the browser's Web Speech API
// (SpeechRecognition + speechSynthesis), replies generated server-side by
// Gemini Flash when GEMINI_API_KEY is configured, local fallback otherwise.

export type Turn = { role: "user" | "assistant"; text: string; latencyMs?: number; offline?: boolean };
export type VoiceMode = "gemini" | "browser";
type Status = "idle" | "listening" | "thinking" | "speaking";

type Handlers = {
  onStatus: (s: Status) => void;
  onTurn: (t: Turn) => void;
  onPartial: (text: string) => void;
  onError: (msg: string) => void;
  onMode: (m: VoiceMode) => void;
  onLevel: (v: number) => void;
  onOffline: (offline: boolean) => void;
};

const RESUME_DELAY_MS = 300;

export class VoiceEngine {
  private h: Handlers;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private recognition: any = null;
  private mode: VoiceMode = "browser";
  private offline = false;
  private history: { role: "user" | "assistant"; text: string }[] = [];
  private speaking = false;
  private abortCtl: AbortController | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: Handlers) {
    this.h = handlers;
  }

  get voiceMode() {
    return this.mode;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.measureLevel();
    const engine = await this.fetchEngine();
    this.mode = engine === "gemini" ? "gemini" : "browser";
    this.startBrowser();
    this.h.onMode(this.mode);
  }

  private async fetchEngine(): Promise<string | null> {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) return null;
      const data = await res.json();
      this.h.onOffline(data.engine === "offline");
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
            if (this.speaking) this.bargeIn();
            this.h.onTurn({ role: "user", text });
            this.speak(text);
          }
        } else interim += r[0].transcript;
      }
      // Barge-in: user started talking while the bot is still speaking.
      if (this.speaking && interim.trim()) this.bargeIn();
      this.h.onPartial(interim);
    };
    rec.onerror = (e: any) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.h.onError(`Speech recognition: ${e.error}`);
    };
    rec.onend = () => {
      if (this.recognition && !this.speaking) {
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

  // User interrupted the bot: cancel TTS and drop the in-flight reply fetch.
  private bargeIn() {
    this.speaking = false;
    window.speechSynthesis?.cancel();
    this.abortCtl?.abort();
    this.abortCtl = null;
  }

  private async speak(text: string) {
    this.h.onStatus("thinking");
    const started = Date.now();
    const synth = window.speechSynthesis;
    if (!synth) {
      this.h.onStatus("listening");
      return;
    }
    this.abortCtl?.abort();
    const ctl = new AbortController();
    this.abortCtl = ctl;

    let reply: string | null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userText: text, history: this.history }),
        signal: ctl.signal,
      });
      const d = await res.json();
      if (typeof d.engine === "string") {
        this.offline = d.engine === "offline";
        this.h.onOffline(this.offline);
      }
      reply = (d.reply as string) || "Sorry, I had trouble responding.";
    } catch (e: any) {
      if (e?.name === "AbortError") return; // barged in; drop the reply
      reply = "Sorry, I had trouble responding.";
    }
    if (ctl.signal.aborted || this.abortCtl !== ctl) return;

    this.history.push({ role: "user", text }, { role: "assistant", text: reply });
    if (this.history.length > 16) this.history = this.history.slice(-16);
    const u = new SpeechSynthesisUtterance(reply);
    u.rate = 1.05;
    u.onstart = () => {
      this.speaking = true;
      this.h.onStatus("speaking");
      // Pause recognition while TTS plays so the bot doesn't hear itself;
      // barge-in is detected through interim results once it restarts.
      try {
        this.recognition?.stop();
      } catch {}
    };
    u.onend = () => {
      this.speaking = false;
      this.resumeAfterTts();
    };
    this.h.onTurn({ role: "assistant", text: reply, latencyMs: Date.now() - started, offline: this.offline });
    synth.speak(u);
  }

  // Give echo tail ~300ms to die out before listening again.
  private resumeAfterTts() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.recognition) {
        this.h.onStatus("listening");
        try {
          this.recognition.start();
        } catch {
          /* already running */
        }
      }
    }, RESUME_DELAY_MS);
  }

  // Send a typed message through the same pipeline (text fallback mode).
  sendText(text: string) {
    const t = text.trim();
    if (!t) return;
    this.h.onTurn({ role: "user", text: t });
    this.speak(t);
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
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.stop();
      } catch {}
    }
    this.analyser = null;
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    window.speechSynthesis?.cancel();
    this.h.onStatus("idle");
  }
}
