// The playground's history save: POST /v1/sessions/{id}/turns on services/api.
import type { Turn, VoiceMode } from "@/voice/provider";

export const turnsPath = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}/turns`;

// Sessions are stored by engine ("gemini" | "browser"); the live voice mode runs on Gemini.
export function turnsBody(mode: VoiceMode | null, turns: Turn[]): string {
  return JSON.stringify({
    mode: mode === "live" ? "gemini" : "browser",
    turns: turns.map((t) => ({
      role: t.role,
      text: t.text,
      latency_ms: t.latencyMs ?? null,
      stt_ms: t.sttMs ?? null,
      first_token_ms: t.firstTokenMs ?? null,
      total_llm_ms: t.totalLlmMs ?? null,
      tts_start_ms: t.ttsStartMs ?? null,
    })),
  });
}
