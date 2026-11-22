"use client";

// Voice provider interface (Phase 6). A provider owns speech in (mic → text)
// and speech out (reply text → audio) and reports timing for every stage so
// the UI can compare providers side by side.
//
// Two implementations ship:
//   - BrowserVoice: Web Speech API (SpeechRecognition + speechSynthesis),
//     replies stream from services/api as SSE (works everywhere Chrome runs).
//   - LiveVoice: Gemini Live API over WebSocket with full-duplex PCM audio;
//     the session is authorized by a short-lived ephemeral token issued by
//     services/api: the GEMINI_API_KEY never reaches the browser.

export type Turn = {
  role: "user" | "assistant";
  text: string;
  latencyMs?: number;
  offline?: boolean;
  sttMs?: number;
  firstTokenMs?: number;
  totalLlmMs?: number;
  ttsStartMs?: number;
};

export type VoiceMode = "live" | "browser";

export type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

// Per-stage latency, measured identically for both providers so the UI can
// show one comparison number per completed turn.
export type TurnLatency = {
  // User speech end → connection/request established.
  connectMs?: number;
  // Request sent → first evidence the model is responding (token or audio).
  firstTokenMs?: number;
  // Full model response duration.
  totalLlmMs?: number;
  // Request sent → first audio actually audible to the user.
  ttsStartMs?: number;
  // Whole turn, user speech end → assistant audio finished.
  totalMs?: number;
};

export type ProviderHandlers = {
  onStatus: (s: VoiceStatus) => void;
  onTurn: (t: Turn) => void;
  onPartial: (text: string) => void;
  onReplyPartial: (text: string) => void;
  onError: (msg: string) => void;
  onMode: (m: VoiceMode) => void;
  onLevel: (v: number) => void;
  onOffline: (offline: boolean) => void;
};

export interface VoiceProvider {
  readonly mode: VoiceMode;
  /** Active interview id for agent-mode requests (null = plain chat). */
  interviewId: string | null;
  /** Selected interview language (BCP-47); "" = follow the browser. */
  language: string;
  start(): Promise<void>;
  stop(): void;
  sendText(text: string): void;
  get latency(): TurnLatency | null;
}

// Shared mic capture + loudness meter. Both providers need the same stream
// and the same onLevel ticks.
export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export function measureLevel(stream: MediaStream, onLevel: (v: number) => void): () => void {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const tick = () => {
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    onLevel(Math.sqrt(sum / buf.length) / 255);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(raf);
    void ctx.close();
  };
}
