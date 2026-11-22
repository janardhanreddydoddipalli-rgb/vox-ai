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
// Live sessions come from services/api (POST /v1/voice/sessions), which mints
// the ephemeral token and binds a voice session to the interview; the live
// model's tool calls and usage go back to that session, so the agent tools
// behave identically in both providers.
import { api } from "@/lib/api-browser";
import { isLanguageCode } from "@/lib/languages";
import { LiveVoice, type LiveSessionConfig } from "./live-voice";
import { BrowserVoice } from "./browser-voice";
import type { ProviderHandlers as Handlers, TurnLatency, VoiceMode, VoiceProvider } from "./provider";

export type { Turn, VoiceMode } from "./provider";

export type EngineHandlers = Handlers & {
  /** Called when auto-selection falls back from live to browser voice. */
  onFallback?: (from: VoiceMode, to: VoiceMode, reason: string) => void;
};

async function fetchSessionConfig(language: string, interviewId: string | null): Promise<LiveSessionConfig> {
  const code = language.split("-")[0];
  const { data, error, response } = await api.POST("/v1/voice/sessions", {
    body: { interview_id: interviewId, language: isLanguageCode(code) ? code : null },
  });
  if (!data) {
    const problem = error as { code?: string; detail?: string } | undefined;
    throw new Error(problem?.code ?? problem?.detail ?? `live session unavailable (${response.status})`);
  }
  return {
    sessionId: data.session_id,
    token: data.token,
    model: data.model,
    systemInstruction: data.system_instruction,
    tools: data.tools,
  };
}

async function executeTool(sessionId: string, name: string, args: unknown, callId?: string): Promise<unknown> {
  try {
    const { data, error } = await api.POST("/v1/voice/sessions/{session_id}/tool-calls", {
      params: { path: { session_id: sessionId } },
      body: { call_id: callId ?? crypto.randomUUID(), name, args: (args ?? {}) as Record<string, unknown> },
    });
    if (!data) return { error: (error as { detail?: string } | undefined)?.detail ?? "tool failed" };
    if (!data.ok) return { error: data.error ?? "tool failed", message: data.message };
    return data.result ?? { ok: true };
  } catch {
    return { error: "tool service unreachable" };
  }
}

async function reportUsage(sessionId: string, promptTokens: number, responseTokens: number) {
  try {
    const { data } = await api.POST("/v1/voice/sessions/{session_id}/usage", {
      params: { path: { session_id: sessionId } },
      body: { prompt_tokens: promptTokens, response_tokens: responseTokens },
    });
    return { budgetExceeded: data?.budget_exceeded === true, message: data?.message ?? null };
  } catch {
    return { budgetExceeded: false, message: null };
  }
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
      const config = await fetchSessionConfig(this.language, this.interviewId);
      const live = new LiveVoice({
        handlers: this.h,
        config,
        toolExecutor: (name, args, callId) => executeTool(config.sessionId, name, args, callId),
        usageReporter: (promptTokens, responseTokens) => reportUsage(config.sessionId, promptTokens, responseTokens),
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
    // Text mode: run the same chat SSE pipeline for typed input, minus
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
