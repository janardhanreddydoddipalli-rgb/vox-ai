import { describe, it, expect, beforeEach, vi } from "vitest";
import { runAgentLoop, MAX_TOOL_STEPS, type LoopCallbacks } from "@/agent/loop";
import { evaluateWithGemini, evaluationSchema } from "@/agent/tools/interview-tools";
import { GEMINI_MODEL } from "@/lib/config";

// Mocks for the two Gemini wire formats the loop uses: generateContent
// (JSON, tool rounds) and streamGenerateContent (SSE, forced final reply).
let jsonResponses: unknown[] = [];
let sseChunks: string[] = [];
let calls: { url: string; body: any }[] = [];

function mockFetch() {
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes("streamGenerateContent")) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of sseChunks) {
            const evt = { candidates: [{ content: { parts: [{ text: chunk }] } }] };
            c.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
          }
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const next = jsonResponses.shift();
    if (next === undefined) return new Response("no more mocked responses", { status: 500 });
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function toolCallPart(name: string, args: unknown = {}) {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] };
}

function textPart(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

beforeEach(() => {
  jsonResponses = [];
  sseChunks = [];
  calls = [];
  mockFetch();
  process.env.GEMINI_API_KEY = "test-key";
});

const cb: LoopCallbacks = {};
const ctx = { userId: "u1", interviewId: null };

describe("agent loop", () => {
  it("returns the model's spoken reply after tool rounds complete", async () => {
    jsonResponses = [
      toolCallPart("get_question", { role: "backend", level: "mid", asked_ids: [] }),
      textPart("Great, here is your next question: explain connection pooling."),
    ];
    const res = await runAgentLoop("start", [], "sys", cb, ctx);
    expect(res.reply).toContain("connection pooling");
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0].toolName).toBe("get_question");
    expect(res.hitStepLimit).toBe(false);
  });

  it("stops at the step limit and forces a spoken reply without tools", async () => {
    // Always answer with a tool call — the loop must give up after 5 rounds.
    jsonResponses = Array.from({ length: MAX_TOOL_STEPS }, () => toolCallPart("get_question", {}));
    sseChunks = ["Time is up, ", "let's wrap up."];
    const res = await runAgentLoop("start", [], "sys", cb, ctx);
    expect(res.hitStepLimit).toBe(true);
    expect(res.steps).toHaveLength(MAX_TOOL_STEPS);
    // The forced final call must omit the tools declaration entirely.
    const forced = calls.at(-1)!;
    expect(forced.url).toContain("streamGenerateContent");
    expect(forced.body.tools).toBeUndefined();
    expect(res.reply).toBe("Time is up, let's wrap up.");
  });

  it("reports unknown tools back to the model instead of crashing", async () => {
    jsonResponses = [toolCallPart("make_coffee", {}), textPart("Sorry, I can't do that.")];
    const res = await runAgentLoop("make me a coffee", [], "sys", cb, ctx);
    expect(res.steps[0].toolName).toBe("make_coffee");
    expect((res.steps[0].output as any).error).toMatch(/Unknown tool/);
    expect(res.reply).toBe("Sorry, I can't do that.");
  });

  it("reports zod-invalid tool arguments back to the model", async () => {
    jsonResponses = [toolCallPart("get_question", { role: "" }), textPart("Okay.")];
    const res = await runAgentLoop("start", [], "sys", cb, ctx);
    expect((res.steps[0].output as any).error).toMatch(/Invalid arguments/);
  });

  it("mocked conversation: a weak answer triggers a spoken follow-up", async () => {
    jsonResponses = [
      toolCallPart("get_question", { role: "backend", level: "mid", asked_ids: [] }),
      toolCallPart("evaluate_answer", { question_id: "00000000-0000-0000-0000-000000000001", answer_text: "I dunno, it caches stuff" }),
      textPart("Not quite — let me follow up: what does the pool actually reuse?"),
    ];
    const res = await runAgentLoop("It caches database stuff I think", [], "sys", cb, ctx);
    expect(res.steps.map((s) => s.toolName)).toEqual(["get_question", "evaluate_answer"]);
    expect(res.reply).toContain("follow up");
    expect(res.hitStepLimit).toBe(false);
  });
});

describe("evaluate_answer output schema", () => {
  it("returns a schema-valid evaluation from a mocked Gemini JSON call", async () => {
    jsonResponses = [
      textPart(
        JSON.stringify({
          score: 4,
          clarity: "Vague and rambling.",
          depth: "Surface level only.",
          correctness: "Partially right about caching.",
          missing_points: ["connection reuse", "pool sizing"],
          follow_up_needed: true,
          follow_up_question: "What does the pool actually reuse?",
        }),
      ),
    ];
    const eval_ = await evaluateWithGemini("Explain connection pooling.", "It caches stuff");
    expect(evaluationSchema.parse(eval_)).toMatchObject({ score: 4, follow_up_needed: true });
  });

  it("throws when Gemini returns a score outside 1-10", async () => {
    jsonResponses = [textPart(JSON.stringify({ score: 11, clarity: "", depth: "", correctness: "", missing_points: [], follow_up_needed: false }))];
    await expect(evaluateWithGemini("q", "a")).rejects.toThrow();
  });
});
