import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from "jose";
import { GET as memoriesGet, DELETE as memoriesDelete } from "@/app/api/memories/route";
import { upsertUserByEmail, createMemory, listMemories } from "@/lib/db";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const zero = Array(768).fill(0);
let publicKey: CryptoKey;

const del = (body: unknown) =>
  new Request("http://localhost:3000/api/memories", { method: "DELETE", body: JSON.stringify(body) }) as any;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  publicKey = pair.publicKey;
  process.env.API_JWT_PRIVATE_KEY = await exportPKCS8(pair.privateKey);
  process.env.API_INTERNAL_URL = "http://api.test";
});

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
});

afterEach(() => {
  delete process.env.ROUTE_MEMORIES;
  vi.unstubAllGlobals();
});

describe("/api/memories, ROUTE_MEMORIES=next (default)", () => {
  it("lists and deletes from the web app's own database", async () => {
    const user = await upsertUserByEmail("user-a@example.com");
    const m = await createMemory({ userId: user!.id, kind: "weakness", text: "joins", embedding: zero });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const list = await (await memoriesGet()).json();
    expect(list.memories.map((x: { text: string }) => x.text)).toEqual(["joins"]);
    expect((await memoriesDelete(del({ id: m.id }))).status).toBe(200);
    expect(await listMemories(user!.id)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/api/memories, ROUTE_MEMORIES=fastapi", () => {
  beforeEach(() => {
    process.env.ROUTE_MEMORIES = "fastapi";
  });

  function stubApi(status: number, body?: unknown, headers: Record<string, string> = {}) {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: Request) => {
        calls.push(input);
        return new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers },
        });
      }),
    );
    return calls;
  }

  it("GET forwards with a user token and keeps the web response shape", async () => {
    const calls = stubApi(200, {
      memories: [{ id: MEMORY_ID, kind: "strength", text: "clear answers", created_at: "2026-11-22T10:00:00Z" }],
    });
    const res = await memoriesGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      memories: [{ id: MEMORY_ID, kind: "strength", text: "clear answers", createdAt: "2026-11-22T10:00:00.000Z" }],
    });

    const req = calls[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe("http://api.test/v1/memories");
    const token = req.headers.get("authorization")!.replace("Bearer ", "");
    const user = await upsertUserByEmail("user-a@example.com");
    expect((await jwtVerify(token, publicKey, { audience: "vox-api" })).payload.sub).toBe(user!.id);
  });

  it("DELETE forwards to /v1/memories/{id}", async () => {
    const calls = stubApi(204);
    const res = await memoriesDelete(del({ id: MEMORY_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe(`http://api.test/v1/memories/${MEMORY_ID}`);
  });

  it("maps the API's 404 to the web's not-found contract", async () => {
    stubApi(404, { status: 404, title: "Not Found", detail: "Memory not found" });
    const res = await memoriesDelete(del({ id: MEMORY_ID }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Memory not found" });
  });

  it("passes the API's 429 through with Retry-After", async () => {
    stubApi(429, { status: 429, title: "Too Many Requests" }, { "Retry-After": "17" });
    const res = await memoriesDelete(del({ id: MEMORY_ID }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
  });

  it("still validates the body before calling the API", async () => {
    const calls = stubApi(204);
    const res = await memoriesDelete(del({ id: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
