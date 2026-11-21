// Mocks global fetch so the routes never call the real Gemini API. The
// stream mock speaks Gemini's `streamGenerateContent?alt=sse` wire format.
const mocks: { url: string; body: unknown }[] = [];

function geminiSseBody(chunks: string[], opts: { failAfter?: number; delayMs?: number } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error("upstream stream broke"));
        return;
      }
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const evt = { candidates: [{ content: { parts: [{ text: chunks[i++] }] } }] };
      controller.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\r\n\r\n`));
    },
  });
}

export function mockGeminiStream(chunks: string[], opts: { failAfter?: number; delayMs?: number } = {}): void {
  const mocked: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    mocks.push({ url: String(url), body });
    return new Response(geminiSseBody(chunks, opts), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  globalThis.fetch = mocked;
}

export function mockGeminiOk(reply = "Test reply"): void {
  mockGeminiStream([reply]);
}

export function mockGeminiFailure(status = 500): void {
  const mocked: typeof fetch = async () => new Response("upstream error", { status });
  globalThis.fetch = mocked;
}

export function recordedCalls(): readonly { url: string; body: unknown }[] {
  return mocks;
}

export type SseEvent = { event: string; data: any };

// Read a whole SSE response into a list of events.
export async function readSse(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7).trim() ?? "message";
      const raw = lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "null";
      return { event, data: JSON.parse(raw) };
    });
}
