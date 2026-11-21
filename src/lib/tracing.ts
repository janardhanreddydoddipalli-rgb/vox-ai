// Langfuse tracing for every agent turn: one trace per turn with the tool
// steps, token counts, latency and estimated cost as spans/generations. The
// SDK is inert (no-op) until LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are set.
// Privacy: we trace ids, tool names, token counts and timings — never
// transcript text, resume content or the full system prompt.
import { Langfuse } from "langfuse";
import { GEMINI_MODEL } from "@/lib/config";
import type { AgentStep } from "@/agent/loop";

let client: Langfuse | null | undefined;

function langfuse(): Langfuse | null {
  if (client !== undefined) return client;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  client = publicKey && secretKey
    ? new Langfuse({ publicKey, secretKey, baseUrl: process.env.LANGFUSE_HOST?.trim() || "https://cloud.langfuse.com" })
    : null;
  return client;
}

// Rough public-price estimate in USD for the cost column. Prices are per
// 1M tokens and can be overridden with env when Gemini pricing changes.
const GEMINI_INPUT_PER_1M = Number(process.env.LANGFUSE_GEMINI_INPUT_PRICE_PER_1M ?? "0.5");
const GEMINI_OUTPUT_PER_1M = Number(process.env.LANGFUSE_GEMINI_OUTPUT_PRICE_PER_1M ?? "1.5");

export function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * GEMINI_INPUT_PER_1M + (outputTokens / 1_000_000) * GEMINI_OUTPUT_PER_1M;
}

export type TurnTrace = {
  traceId: string;
  finish: (result: { tokensIn: number; tokensOut: number; latencyMs: number; toolSteps: AgentStep[]; hitStepLimit: boolean }) => Promise<void>;
  fail: (error: unknown) => void;
};

// Start a trace for one agent turn. `ids` carry correlation only — userId and
// interviewId are uuids, never user content.
export function startTurnTrace(ids: { userId: string; interviewId: string; sessionId: string; provider: string }): TurnTrace {
  const lf = langfuse();
  if (!lf) {
    // No key configured: return a no-op trace so callers stay unchanged.
    return {
      traceId: "",
      finish: async () => {},
      fail: () => {},
    };
  }

  const startedAt = Date.now();
  const trace = lf.trace({
    name: "agent-turn",
    userId: ids.userId,
    sessionId: ids.sessionId,
    metadata: { interviewId: ids.interviewId, provider: ids.provider, model: GEMINI_MODEL },
  });

  const stepSpans = new Map<number, { end: (output: unknown) => void }>();

  return {
    traceId: trace.id,
    fail(error) {
      trace.event({ name: "turn-error", statusMessage: error instanceof Error ? error.message : String(error) });
      void lf.shutdownAsync();
    },
    async finish({ tokensIn, tokensOut, latencyMs, toolSteps, hitStepLimit }) {
      // One span per executed tool, with its duration and tool name.
      for (const step of toolSteps) {
        trace.span({
          name: `tool:${step.toolName}`,
          startTime: new Date(startedAt + step.stepIndex * 1),
          endTime: new Date(startedAt + step.stepIndex * 1 + step.durationMs),
          metadata: { stepIndex: step.stepIndex, toolName: step.toolName, durationMs: step.durationMs },
        });
        stepSpans.set(step.stepIndex, { end: () => {} });
      }

      trace.generation({
        name: "gemini-turn",
        model: GEMINI_MODEL,
        usage: { input: tokensIn, output: tokensOut, total: tokensIn + tokensOut, unit: "TOKENS" },
        metadata: {
          latencyMs,
          costUsd: estimateCost(tokensIn, tokensOut),
          toolStepCount: toolSteps.length,
          hitStepLimit,
        },
      });

      void lf.shutdownAsync();
    },
  };
}

export async function shutdownTracing() {
  await client?.shutdownAsync();
  client = undefined;
}

// Span for a single tool call (used by the live-voice tool relay). Returns
// null when Langfuse is not configured.
export function startToolSpan(ids: { userId: string; interviewId: string; name: string }) {
  const lf = langfuse();
  if (!lf) return null;
  const startedAt = new Date();
  const span = lf.trace({ name: "live-tool-call", userId: ids.userId, metadata: { interviewId: ids.interviewId } })
    .span({ name: `tool:${ids.name}`, startTime: startedAt });
  return {
    end: (result: { ok: boolean; error?: string }) => {
      span.end({
        endTime: new Date(),
        metadata: { ok: result.ok, error: result.error, durationMs: Date.now() - startedAt.getTime() },
      } as Parameters<typeof span.end>[0]);
      void lf.shutdownAsync();
    },
  };
}
