"use client";

// VoiceEngine (Phase 6): picks the best available voice provider and hides
// the switch from the UI.
//
//   1. LiveVoice  — Gemini Live API over WebSocket, if the server can mint an
//      ephemeral token (needs GEMINI_API_KEY) and the browser supports
//      WebSocket + AudioWorklet.
//   2. BrowserVoice — Web Speech API fallback (Chrome/Edge desktop+Android).
//   3. Text mode  — the page's own fallback when start() throws (no mic, no
//      SpeechRecognition); sendText still works everywhere.
//
// Tool calls made by the live model are executed through /api/voice/tool so
// the Phase 3 agent tools behave identically in both providers.
import { LiveVoice, type LiveSessionConfig } from "./live-voice";
import { BrowserVoice } from "./browser-voice";
import type { ProviderHandlers as Handlers, TurnLatency, VoiceMode, VoiceProvider } from "./provider";

export type { Turn, VoiceMode } from "./provider";

export type EngineHandlers = Handlers & {
  /** Called when auto-selection falls back from live to browser voice. */
  onFallback?: (from: VoiceMode, to: VoiceMode, reason: string) => void;
};

async function fetchSessionConfig(language: string): Promise<LiveSessionConfig> {
  const res = await fetch("/api/voice/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(language ? { language } : {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `live session unavailable (${res.status})`);
  }
  return res.json();
}

async function executeTool(name: string, args: unknown, interviewId: string | null): Promise<unknown> {
  const res = await fetch("/api/voice/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args, interviewId }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "tool route unreachable" }));
  if (!data.ok) return { error: data.error ?? "tool failed", message: data.message };
  return data.result;
}

async function reportUsage(interviewId: string | null, promptTokens: number, responseTokens: number) {
  const res = await fetch("/api/voice/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interviewId, promptTokens, responseTokens }),
  });
  if (!res.ok) return { budgetExceeded: false, message: null };
  const data = await res.json().catch(() => ({}));
  return { budgetExceeded: data.budgetExceeded === true, message: data.message ?? null };
}

export class VoiceEngine {
  interviewId: string | null = null;
  language = "";

  private h: EngineHandlers;
  private provider: VoiceProvider | null = null;

  constructor(handlers: EngineHandlers) {
    this.h = handlers;
  }

  get mode(): VoiceMode | null {
    return this.provider?.mode ?? null;
  }

  get latency(): TurnLatency | null {
    return this.provider?.latency ?? null;
  }

  async start(): Promise<VoiceMode> {
    this.stop();
    // 1) Try the Gemini Live API.
    try {
      const config = await fetchSessionConfig(this.language);
      const live = new LiveVoice({
        handlers: this.h,
        config,
        toolExecutor: (name, args) => executeTool(name, args, this.interviewId),
        usageReporter: (promptTokens, responseTokens) => reportUsage(this.interviewId, promptTokens, responseTokens),
      });
      live.language = this.language;
      live.interviewId = this.interviewId;
      await live.start();
      this.provider = live;
      return live.mode;
    } catch (liveErr) {
      const reason = liveErr instanceof Error ? liveErr.message : "live voice unavailable";
      // 2) Fall back to the browser's Web Speech API.
      try {
        const browser = new BrowserVoice(this.h);
        browser.language = this.language;
        browser.interviewId = this.interviewId;
        await browser.start();
        this.provider = browser;
        this.h.onFallback?.("live", "browser", reason);
        return browser.mode;
      } catch (browserErr) {
        const bReason = browserErr instanceof Error ? browserErr.message : "microphone unavailable";
        // 3) Text mode: the page keeps sendText working through this error.
        this.provider = null;
        this.h.onFallback?.("browser", "browser", reason);
        throw new Error(bReason);
      }
    }
  }

  sendText(text: string) {
    if (this.provider) {
      this.provider.sendText(text);
      return;
    }
    // Text mode: run the same /api/chat SSE pipeline for typed input, minus
    // speech. A BrowserVoice that was never start()ed captures no mic —
    // sendText alone drives the pipeline.
    const fallback = new BrowserVoice(this.h);
    fallback.language = this.language;
    fallback.interviewId = this.interviewId;
    this.provider = fallback;
    fallback.sendText(text);
  }

  stop() {
    this.provider?.stop();
    this.provider = null;
  }
}
