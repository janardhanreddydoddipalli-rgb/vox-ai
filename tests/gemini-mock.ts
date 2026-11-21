// Mocks global fetch so the routes never call the real Gemini API.
const mocks: { url: string; body: unknown }[] = [];

export function mockGeminiOk(reply = "Test reply"): void {
  const mocked: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    mocks.push({ url: String(url), body });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }),
      { status: 200 },
    );
  };
  globalThis.fetch = mocked;
}

export function mockGeminiFailure(status = 500): void {
  const mocked: typeof fetch = async () => new Response("upstream error", { status });
  globalThis.fetch = mocked;
}

export function recordedCalls(): readonly { url: string; body: unknown }[] {
  return mocks;
}
