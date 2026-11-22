"use client";

// LiveVoice: Gemini Live API over WebSocket with full-duplex PCM audio.
// Authentication uses a short-lived ephemeral token minted by
// /api/voice/token — the GEMINI_API_KEY never reaches the browser.
//
// The live model calls the same agent tools as the text path: tool
// declarations are sent in the setup message, and every `toolCall` frame is
// executed locally through `toolExecutor` and answered with a `toolResponse`
// frame, so the model can start/save/end interviews mid-conversation.
import {
  getMicStream,
  measureLevel,
  type ProviderHandlers as Handlers,
  type TurnLatency,
  type VoiceProvider,
} from "./provider";

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const VOICE_NAME = "Aoede";

// Everything the live session needs, delivered by POST /api/voice/session:
// the ephemeral token, the live model id, the system prompt and the agent
// function declarations (single source of truth with the text agent).
export type LiveSessionConfig = {
  /** Server-issued voice session id (ROUTE_VOICE=fastapi); keys tool calls and usage. */
  sessionId?: string;
  token: string;
  model: string;
  systemInstruction: string;
  tools: unknown[];
};

/** callId is Gemini's functionCall id: a retried call replays its stored result. */
export type ToolExecutor = (name: string, args: unknown, callId?: string) => Promise<unknown>;

export type UsageVerdict = { budgetExceeded: boolean; message: string | null };
/** Forwards one usageMetadata frame to the server's cost guard. */
export type UsageReporter = (promptTokens: number, responseTokens: number) => Promise<UsageVerdict>;

export type LiveVoiceOptions = {
  handlers: Handlers;
  config: LiveSessionConfig;
  /** Executes one agent tool call and returns its JSON result. */
  toolExecutor: ToolExecutor;
  usageReporter: UsageReporter;
};

const BUDGET_FALLBACK_MESSAGE = "You've reached today's practice budget, so I'll pause here. It resets tomorrow.";


/** The session's first frame: system prompt, tools, audio in/out with a fixed
 *  voice, and the requested speech language. */
export function liveSetupMessage(config: LiveSessionConfig, language: string) {
  return {
    setup: {
      model: config.model,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } },
          ...(language ? { languageCode: language.split("-")[0] } : {}),
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: config.systemInstruction }] },
      // setup.tools holds Tool objects; the declarations go inside one of them.
      tools: [{ functionDeclarations: config.tools }],
    },
  };
}

type PendingTurn = {
  text: string;
  startedAt: number;
  firstTokenMs?: number;
  ttsStartMs?: number;
  connectMs?: number;
};

export class LiveVoice implements VoiceProvider {
  readonly mode = "live" as const;
  interviewId: string | null = null;
  language = "";

  private h: Handlers;
  private opts: LiveVoiceOptions;
  private config: LiveSessionConfig;
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private stopLevel: (() => void) | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending: PendingTurn | null = null;
  private history: { role: "user" | "assistant"; text: string }[] = [];
  private lastLatency: TurnLatency | null = null;
  private closed = false;
  private startedAt = 0;
  private connectMs: number | undefined;
  private userBuf = "";

  constructor(opts: LiveVoiceOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.h = opts.handlers;
  }

  get latency() {
    return this.lastLatency;
  }

  async start() {
    this.startedAt = Date.now();
    this.closed = false;
    this.connectMs = undefined;
    this.userBuf = "";
    this.pending = null;
    this.stream = await getMicStream();
    this.stopLevel = measureLevel(this.stream, (v) => this.h.onLevel(v));

    const ws = new WebSocket(`${WS_BASE}?access_token=${encodeURIComponent(this.config.token)}`);
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Live voice connection timed out")), 10000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("Live voice connection failed"));
      };
    });

    ws.onmessage = (e) => this.onMessage(e.data);
    ws.onclose = () => {
      if (!this.closed) this.h.onError("Live voice disconnected — switch back to browser voice or text.");
      this.stopAudio();
    };
    ws.onerror = () => {
      if (!this.closed) this.h.onError("Live voice connection error.");
    };

    ws.send(JSON.stringify(liveSetupMessage(this.config, this.language)));

    await this.startCapture();
    this.h.onMode(this.mode);
    this.h.onStatus("listening");
  }

  // ---- mic capture: 16 kHz mono PCM16 frames -> realtimeInput -------------
  private async startCapture() {
    this.inCtx = new AudioContext({ sampleRate: INPUT_RATE });
    const blob = new Blob(
      [
        `class Pcm extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm", Pcm);`,
      ],
      { type: "application/javascript" },
    );
    const url = URL.createObjectURL(blob);
    await this.inCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = this.inCtx.createMediaStreamSource(this.stream!);
    this.node = new AudioWorkletNode(this.inCtx, "pcm");
    this.node.port.onmessage = (e) => this.sendAudioFrame(e.data as Float32Array);
    src.connect(this.node);
    this.node.connect(this.inCtx.destination); // worklets need a path to run
  }

  private sendAudioFrame(frame: Float32Array) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const pcm = new Int16Array(frame.length);
    for (let i = 0; i < frame.length; i++) {
      const s = Math.max(-1, Math.min(1, frame[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bin = String.fromCharCode(...new Uint8Array(pcm.buffer));
    const b64 = btoa(bin);
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: b64 }],
        },
      }),
    );
  }

  // ---- playback: schedule 24 kHz PCM16 chunks on one timeline --------------
  private playAudio(b64: string) {
    if (!this.outCtx) this.outCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const pcm = new Int16Array(buf.buffer);
    const audio = new AudioBuffer({
      sampleRate: OUTPUT_RATE,
      length: pcm.length,
      numberOfChannels: 1,
    });
    const data = audio.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const ctx = this.outCtx;
    const now = ctx.currentTime;
    if (this.playHead < now) this.playHead = now + 0.02;
    if (this.pending?.ttsStartMs == null) {
      this.pending && (this.pending.ttsStartMs = Date.now() - this.pending.startedAt);
    }
    const source = ctx.createBufferSource();
    source.buffer = audio;
    source.connect(ctx.destination);
    source.start(this.playHead);
    this.playHead += audio.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) {
        this.playHead = 0;
        this.finishAssistantTurn();
      }
    };
  }

  private stopAudio() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.playHead = 0;
  }

  // ---- server frames -------------------------------------------------------
  private async onMessage(raw: unknown) {
    let text: string;
    if (raw instanceof Blob) text = await raw.text();
    else if (raw instanceof ArrayBuffer) text = new TextDecoder().decode(raw);
    else text = String(raw);
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.setupComplete) {
      this.connectMs = Date.now() - this.startedAt;
    }

    // Token usage → server cost guard. Fire-and-forget so audio never waits
    // on it; an over-budget verdict ends the session.
    if (msg.usageMetadata) {
      const u = msg.usageMetadata;
      const promptTokens = Number(u.promptTokenCount) || 0;
      const responseTokens = Number(u.responseTokenCount ?? u.candidatesTokenCount) || 0;
      if (promptTokens > 0 || responseTokens > 0) {
        this.opts
          .usageReporter(promptTokens, responseTokens)
          .then((v) => {
            if (v.budgetExceeded) this.endForBudget(v.message);
          })
          .catch(() => {});
      }
    }

    const content = msg.serverContent;
    if (content) {
      if (content.interrupted) {
        // User started talking over the model: stop playback immediately.
        this.stopAudio();
        if (this.pending) this.flushAssistantTurn();
      }
      if (content.inputTranscription?.text) {
        this.userBuf += content.inputTranscription.text;
        this.h.onPartial(this.userBuf);
      }
      const turn = content.modelTurn;
      if (turn?.parts?.length) {
        // The user's turn is complete once the model starts answering.
        if (this.userBuf.trim()) {
          this.h.onTurn({ role: "user", text: this.userBuf.trim() });
          this.userBuf = "";
        }
        if (!this.pending) {
          this.pending = { text: "", startedAt: Date.now(), connectMs: this.connectMs };
        }
        if (this.pending.firstTokenMs == null) {
          this.pending.firstTokenMs = Date.now() - this.pending.startedAt;
        }
        for (const part of turn.parts) {
          if (part.text) {
            this.pending ??= { text: "", startedAt: Date.now() };
            this.pending.text += part.text;
            this.h.onReplyPartial(this.pending.text);
          }
          if (part.inlineData?.data) this.playAudio(part.inlineData.data);
        }
      }
      if (content.turnComplete) {
        this.finishAssistantTurn(true);
      }
    }

    // Agent tool call: execute through the shared agent-tool handlers and
    // answer the model so the session continues.
    if (msg.toolCall?.functionCalls?.length) {
      for (const call of msg.toolCall.functionCalls) {
        let response: unknown;
        try {
          response = await this.opts.toolExecutor(call.name, call.args ?? {}, call.id);
        } catch (e: any) {
          response = { error: e?.message ?? "tool failed" };
        }
        const r = response as { error?: string; message?: string } | null;
        if (r?.error === "budget_exceeded") {
          this.endForBudget(r.message ?? null);
          return;
        }
        this.ws?.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [
                {
                  id: call.id,
                  name: call.name,
                  response: { result: response ?? {} },
                },
              ],
            },
          }),
        );
      }
    }
  }

  // Emit the assistant turn once its audio has finished playing (or the text
  // turn completed). Audio-end path passes no flag; turnComplete path forces
  // emission even if audio is still draining.
  private finishAssistantTurn(force = false) {
    const pending = this.pending;
    if (!pending) return;
    if (!force && this.sources.size > 0) return; // audio still playing
    this.pending = null;
    const latency: TurnLatency = {
      connectMs: pending.connectMs,
      firstTokenMs: pending.firstTokenMs,
      totalLlmMs: pending.firstTokenMs,
      ttsStartMs: pending.ttsStartMs,
      totalMs: Date.now() - pending.startedAt,
    };
    this.lastLatency = latency;
    if (pending.text.trim()) {
      this.history.push({ role: "assistant", text: pending.text });
      if (this.history.length > 16) this.history = this.history.slice(-16);
      this.h.onTurn({
        role: "assistant",
        text: pending.text,
        latencyMs: latency.totalMs,
        sttMs: undefined,
        firstTokenMs: pending.firstTokenMs,
        totalLlmMs: pending.firstTokenMs,
        ttsStartMs: pending.ttsStartMs,
      });
    }
    this.h.onStatus("listening");
  }

  // Over the daily budget: close the live session and tell the user in the
  // transcript (the same message the text path speaks).
  private endForBudget(message: string | null) {
    if (this.closed) return;
    this.stop();
    this.h.onTurn({ role: "assistant", text: message ?? BUDGET_FALLBACK_MESSAGE });
    this.h.onStatus("idle");
  }

  private flushAssistantTurn() {
    const pending = this.pending;
    if (!pending?.text.trim()) return;
    this.h.onTurn({ role: "assistant", text: pending.text });
  }

  sendText(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const t = text.trim();
    if (!t) return;
    this.h.onTurn({ role: "user", text: t });
    this.pending = { text: "", startedAt: Date.now(), connectMs: this.connectMs };
    this.h.onStatus("thinking");
    // clientContent turns the text into a model turn; audio reply follows.
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [{ text: t }],
            },
          ],
          turnComplete: true,
        },
      }),
    );
  }

  stop() {
    this.closed = true;
    this.stopAudio();
    this.node?.port.close();
    this.node?.disconnect();
    this.node = null;
    void this.inCtx?.close().catch(() => {});
    this.inCtx = null;
    void this.outCtx?.close().catch(() => {});
    this.outCtx = null;
    this.stopLevel?.();
    this.stopLevel = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {}
    }
  }
}
