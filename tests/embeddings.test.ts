import { describe, it, expect, beforeEach, vi } from "vitest";
import { embedText, embedTexts, EMBEDDING_DIMENSIONS } from "@/lib/embeddings";

// Mocked batchEmbedContents: returns one un-normalised vector per request
// (Gemini only guarantees unit length at the full 3072 dims; truncated
// Matryoshka outputs must be re-normalised by the caller).
let requests: any[] = [];

function mockEmbeddings(dims = EMBEDDING_DIMENSIONS) {
  globalThis.fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    requests = body.requests;
    const embeddings = body.requests.map(() => ({ values: Array.from({ length: dims }, () => 3) }));
    return new Response(JSON.stringify({ embeddings }), { status: 200 });
  }) as any;
}

const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

beforeEach(() => {
  requests = [];
  process.env.GEMINI_API_KEY = "test-key";
});

describe("Gemini embeddings", () => {
  it("requests 768 dimensions explicitly (the API default is 3072)", async () => {
    mockEmbeddings();
    await embedTexts(["a", "b"]);
    expect(requests).toHaveLength(2);
    for (const r of requests) expect(r.outputDimensionality).toBe(768);
  });

  it("documents use RETRIEVAL_DOCUMENT, queries use RETRIEVAL_QUERY", async () => {
    mockEmbeddings();
    await embedTexts(["resume chunk"]);
    expect(requests[0].taskType).toBe("RETRIEVAL_DOCUMENT");
    await embedText("what are my weaknesses?");
    expect(requests[0].taskType).toBe("RETRIEVAL_QUERY");
  });

  it("returns unit-length vectors so dot product = cosine similarity", async () => {
    mockEmbeddings();
    const [v] = await embedTexts(["x"]);
    expect(v).toHaveLength(768);
    expect(norm(v)).toBeCloseTo(1, 6);
  });

  it("still rejects a response with the wrong dimension", async () => {
    mockEmbeddings(3072);
    await expect(embedTexts(["x"])).rejects.toThrow(/malformed/);
  });
});
