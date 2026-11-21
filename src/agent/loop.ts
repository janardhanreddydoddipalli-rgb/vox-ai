// The Vox agent loop: Gemini function calling with a hard cap of
// MAX_TOOL_STEPS tool steps per user turn, after which the model must produce
// a spoken reply. The final reply streams through the Phase 2 SSE pipeline.
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/config";
import { toolRegistry, getTool, type ToolContext } from "./tools";
import { addAgentStep } from "@/lib/db/repository";

export const MAX_TOOL_STEPS = 5;

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// One tool execution recorded for tracing.
export type AgentStep = {
  stepIndex: number;
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
};

export type LoopMessage = { role: "user" | "model" | "tool"; text?: string; toolName?: string; toolJson?: unknown };

export type LoopCallbacks = {
  onToken?: (t: string) => void;
  onSentence?: (s: string) => void;
};

export type LoopResult = {
  reply: string;
  steps: AgentStep[];
  hitStepLimit: boolean;
};

// Gemini FunctionDeclarations built from the registry (name, description,
// zod-derived JSON schema). Shared by the text agent loop and the live-voice
// session setup so both paths expose exactly the same tools.
export function functionDeclarations() {
  return toolRegistry().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: zodToGeminiSchema(t.inputSchema),
  }));
}

// Convert a flat zod object schema to the OpenAPI subset Gemini accepts.
function zodToGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  if (schema instanceof z.ZodObject) {
    for (const [key, valueSchema] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      const optional = valueSchema instanceof z.ZodOptional || valueSchema instanceof z.ZodNullable;
      const inner = unwrap(valueSchema);
      const typeName = geminiTypeName(inner);
      const prop: Record<string, unknown> = { type: typeName };
      if (inner instanceof z.ZodArray) {
        prop.items = { type: geminiTypeName(unwrap(inner.element as z.ZodType)) };
      }
      properties[key] = prop;
      if (!optional) required.push(key);
    }
  }
  return { type: "object", properties, required };
}

function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodType;
  return s;
}

function geminiTypeName(schema: z.ZodType): string {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodArray) return "array";
  return "string";
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: unknown };
  functionResponse?: { name: string; response: unknown };
};

function apiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key ? key : null;
}

// Run the agent loop for one user turn. Yields tokens/sentences through the
// callbacks as the final reply streams; returns the full reply and the traced
// tool steps. `history` holds earlier turns plus this loop's tool exchanges.
export async function runAgentLoop(
  userText: string,
  history: LoopMessage[],
  systemPrompt: string,
  callbacks: LoopCallbacks,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<LoopResult> {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not set");

  const steps: AgentStep[] = [];
  let hitStepLimit = false;
  const contents: { role: "user" | "model"; parts: GeminiPart[] }[] = history.map((m) => ({
    role: m.role === "model" ? "model" : "user",
    parts: [m.text != null ? { text: m.text } : { functionResponse: { name: m.toolName ?? "tool", response: m.toolJson as object } }],
  }));
  contents.push({ role: "user", parts: [{ text: userText }] });

  const tools = [{ functionDeclarations: functionDeclarations() }];

  // Up to MAX_TOOL_STEPS rounds of tool calling, then force a text reply.
  for (let round = 0; round < MAX_TOOL_STEPS; round++) {
    const res = await fetch(`${BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        tools,
        generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Gemini generateContent failed: ${res.status}`);

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const parts: GeminiPart[] = candidate?.content?.parts ?? [];

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    if (calls.length === 0) {
      // No tool call: this text is the final reply.
      const reply = parts.map((p) => p.text ?? "").join("").trim();
      if (reply) streamReply(reply, callbacks);
      return { reply, steps, hitStepLimit };
    }

    // Execute each tool call, trace it, and feed responses back to the model.
    const responseParts: GeminiPart[] = [];
    for (const call of calls) {
      const startedAt = Date.now();
      const tool = getTool(call.name);
      let output: unknown;
      if (!tool) {
        // Unknown tool: report the error back to the model rather than crashing.
        output = { error: `Unknown tool: ${call.name}` };
      } else {
        const parsed = tool.inputSchema.safeParse(call.args);
        if (!parsed.success) {
          output = { error: `Invalid arguments for ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
        } else {
          try {
            output = await tool.handler(parsed.data, ctx);
          } catch (err) {
            output = { error: `Tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
      }
      const stepIndex = steps.length;
      const durationMs = Date.now() - startedAt;
      const step: AgentStep = { stepIndex, toolName: call.name, input: call.args, output, durationMs };
      steps.push(step);
      if (ctx.interviewId) {
        try {
          await addAgentStep({ interviewId: ctx.interviewId, ...step });
        } catch (err) {
          console.error("agent step trace failed", err);
        }
      }
      responseParts.push({
        functionResponse: { name: call.name, response: { result: output ?? { ok: true } } },
      });
    }
    contents.push({ role: "model", parts: calls.map((c) => ({ functionCall: c })) });
    contents.push({ role: "user", parts: responseParts });
  }

  // Step limit reached: one final call with NO tools so the model must speak.
  hitStepLimit = true;
  const res = await fetch(`${BASE_URL}/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.6, maxOutputTokens: 1024 },
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini forced-reply stream failed: ${res.status}`);

  let reply = "";
  for await (const text of sseTextStream(res)) {
    reply += text;
    callbacks.onToken?.(text);
    callbacks.onSentence?.(text);
  }
  return { reply: reply.trim(), steps, hitStepLimit };
}

// Split a reply into sentence-sized chunks and emit each through the callbacks
// so the TTS queue starts as soon as the first sentence exists.
function streamReply(reply: string, callbacks: LoopCallbacks) {
  const sentences = reply.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [reply];
  for (const s of sentences) {
    if (s.trim()) callbacks.onSentence?.(s.trim());
  }
  callbacks.onToken?.(reply);
}

// Minimal SSE reader for Gemini's streamGenerateContent?alt=sse format.
async function* sseTextStream(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const parts: GeminiPart[] = json.candidates?.[0]?.content?.parts ?? [];
        for (const p of parts) if (p.text) yield p.text;
      } catch {
        // partial JSON across chunks — ignored, next chunk completes it
      }
    }
  }
}

// Trace helper retained for callers that want to record a step manually.
export async function traceStep(interviewId: string, step: AgentStep) {
  await addAgentStep({ interviewId, ...step });
}
