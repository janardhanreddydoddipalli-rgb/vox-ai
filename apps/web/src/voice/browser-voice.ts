"use client";

// BrowserVoice: speech in/out via the Web Speech API (SpeechRecognition +
// speechSynthesis). Replies stream from services/api as SSE (POST /v1/chat, or
// /v1/interviews/{id}/turns in an interview: meta / token / sentence / done /
// error); each completed sentence is queued to TTS so speech starts on the first.
import { apiFetch, SignedOutError } from "@/lib/api-browser";
import {
  getMicStream,
  measureLevel,
  type ProviderHandlers as Handlers,
  type TurnLatency,
  type VoiceProvider,
} from "./provider";

const RESUME_DELAY_MS = 300;
const OFFLINE_REPLY = "Sorry, I had trouble responding. I'm running in offline mode right now.";
const NOT_FOUND_REPLY = "I couldn't find that interview.";

export class BrowserVoice implements VoiceProvider {
  readonly mode = "browser" as const;
  interviewId: string | null = null;
  language = "";

  private h: Handlers;
  private stream: MediaStream | null = null;
  private stopLevel: (() => void) | null = null;
  private recognition: any = null;
  private offline = false;
  private history: { role: "user" | "assistant"; text: string }[] = [];
  private speaking = false;
  private ttsQueue: SpeechSynthesisUtterance[] = [];
  private abortCtl: AbortController | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private sttStart = 0;
  private lastLatency: TurnLatency | null = null;

  constructor(handlers: Handlers) {
    this.h = handlers;
  }

  get latency() {
    return this.lastLatency;
  }

  // Start voice: capture the mic and begin recognition. Callers that only
  // want typed text (text fallback mode) construct the provider and use
  // sendText without calling start().
  async start() {
    this.stream = await getMicStream();
    this.stopLevel = measureLevel(this.stream, (v) => this.h.onLevel(v));
    this.startRecognition();
    this.h.onMode(this.mode);
  }

  private startRecognition() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      this.h.onError("This browser has no Web Speech API. Chrome or Edge on desktop/Android is required.");
      return;
    }
    const rec = new SR();
    this.recognition = rec;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.language || navigator.language || "en-US";
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) {
            const sttMs = this.sttStart ? Date.now() - this.sttStart : undefined;
            this.sttStart = 0;
            if (this.speaking) this.bargeIn();
            this.h.onTurn({ role: "user", text, sttMs });
            this.speak(text, sttMs);
          }
        } else interim += r[0].transcript;
      }
      // Barge-in: user started talking while the bot is still speaking.
      if (this.speaking && interim.trim()) this.bargeIn();
      this.h.onPartial(interim);
    };
    rec.onspeechstart = () => {
      if (!this.sttStart) this.sttStart = Date.now();
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

  // User interrupted the bot: flush the TTS queue, cancel current speech and
  // abort the in-flight SSE stream.
  private bargeIn() {
    this.speaking = false;
    this.ttsQueue = [];
    window.speechSynthesis?.cancel();
    this.abortCtl?.abort();
    this.abortCtl = null;
  }

  private async speak(text: string, sttMs?: number) {
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

    let gotFirstToken = false;
    let full = "";
    let firstTokenMs: number | undefined;
    let totalLlmMs: number | undefined;
    let streamError: string | null = null;
    let fallbackReply = OFFLINE_REPLY;
    let firstSpokenAt: number | null = null;
    const latency: TurnLatency = { connectMs: undefined };

    const queueSentence = (sentence: string) => {
      const s = sentence.trim();
      if (!s) return;
      const u = new SpeechSynthesisUtterance(s);
      u.rate = 1.05;
      if (this.language) u.lang = this.language;
      u.onstart = () => {
        if (firstSpokenAt == null) firstSpokenAt = Date.now() - started;
        this.speaking = true;
        this.h.onStatus("speaking");
        // Pause recognition while TTS plays so the bot doesn't hear itself.
        try {
          this.recognition?.stop();
        } catch {}
      };
      u.onend = () => this.speakNext(synth, started);
      this.ttsQueue.push(u);
      if (!synth.speaking && !synth.pending) this.speakNext(synth, started);
    };

    try {
      // An interview's turns run the agent there; otherwise plain chat.
      const path = this.interviewId ? `/v1/interviews/${encodeURIComponent(this.interviewId)}/turns` : "/v1/chat";
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_text: text, history: this.history }),
        signal: ctl.signal,
      });
      latency.connectMs = Date.now() - started;
      if (res.status === 404 || res.status === 422) fallbackReply = NOT_FOUND_REPLY;
      if (!res.ok || !res.body) throw new Error(`stream unavailable (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() ?? "";
        for (const block of blocks) {
          const lines = block.split("\n");
          const event = lines.find((l) => l.startsWith("event: "))?.slice(7).trim();
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!event || !dataLine) continue;
          let data: any;
          try {
            data = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          if (event === "meta") {
            this.offline = data.engine === "offline";
            this.h.onOffline(this.offline);
          } else if (event === "token") {
            if (!gotFirstToken) {
              gotFirstToken = true;
              firstTokenMs = data.first_token_ms ?? Date.now() - started;
              latency.firstTokenMs = firstTokenMs;
            }
            full += data.text ?? "";
            this.h.onReplyPartial(full); // live tokens in the transcript
          } else if (event === "sentence") {
            queueSentence(data.text ?? "");
          } else if (event === "done") {
            totalLlmMs = data.total_llm_ms ?? Date.now() - started;
            latency.totalLlmMs = totalLlmMs;
          } else if (event === "error") {
            streamError = data.message ?? "The reply was cut off.";
            this.h.onError(streamError ?? "The reply was cut off.");
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return; // barged in; drop the reply
      if (e instanceof SignedOutError) fallbackReply = e.message;
      streamError = e?.message ?? "stream failed";
      console.warn("chat stream failed before first token:", streamError);
    }

    if (ctl.signal.aborted || this.abortCtl !== ctl) return;

    // Offline fallback when the stream failed before the first token arrived.
    if (!gotFirstToken && streamError) {
      const fallback = fallbackReply;
      this.offline = true;
      this.h.onOffline(true);
      this.history.push({ role: "user", text }, { role: "assistant", text: fallback });
      if (this.history.length > 16) this.history = this.history.slice(-16);
      this.h.onTurn({
        role: "assistant",
        text: fallback,
        latencyMs: Date.now() - started,
        offline: true,
        sttMs,
        firstTokenMs: Date.now() - started,
        totalLlmMs: Date.now() - started,
        ttsStartMs: Date.now() - started,
      });
      const u = new SpeechSynthesisUtterance(fallback);
      u.rate = 1.05;
      if (this.language) u.lang = this.language;
      u.onstart = () => {
        this.speaking = true;
        this.h.onStatus("speaking");
      };
      u.onend = () => {
        this.speaking = false;
        this.resumeAfterTts();
      };
      synth.speak(u);
      return;
    }

    if (full.trim()) {
      const ttsStartMs = firstSpokenAt ?? Date.now() - started;
      latency.firstTokenMs = latency.firstTokenMs ?? firstTokenMs;
      latency.ttsStartMs = ttsStartMs;
      latency.totalMs = Date.now() - started;
      this.lastLatency = latency;
      this.history.push({ role: "user", text }, { role: "assistant", text: full });
      if (this.history.length > 16) this.history = this.history.slice(-16);
      this.h.onTurn({
        role: "assistant",
        text: full,
        latencyMs: Date.now() - started,
        offline: this.offline,
        sttMs,
        firstTokenMs,
        totalLlmMs,
        ttsStartMs,
      });
    }

    // Nothing was queued (empty reply): resume listening.
    if (this.ttsQueue.length === 0 && !this.speaking) {
      this.resumeAfterTts();
    }
  }

  private speakNext(synth: SpeechSynthesis, started: number) {
    const u = this.ttsQueue.shift();
    if (!u) {
      this.speaking = false;
      if (this.lastLatency) this.lastLatency = { ...this.lastLatency, totalMs: Date.now() - started };
      this.resumeAfterTts();
      return;
    }
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

  stop() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.stop();
      } catch {}
    }
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.ttsQueue = [];
    this.stopLevel?.();
    this.stopLevel = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
