// Mocks global fetch so the routes never call the real Gemini API.
const mocks: { url: string; body: any }[] = [];

// @ts-expect-error augmenting for tests
globalThis.__geminiMocks = mocks;

export function mockGeminiOk(reply = "Test reply") {
  globalThis.fetch = (async (url: any, init: any) => {
    mocks.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }),
      { status: 200 },
    );
  }) as any;
}

export function mockGeminiFailure(status = 500) {
  globalThis.fetch = (async () => new Response("upstream error", { status })) as any;
}

export function recordedCalls() {
  return mocks;
}
