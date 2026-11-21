import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { POST as turnsPost, GET as turnsGet } from "@/app/api/turns/route";
import { DELETE as deleteMe } from "@/app/api/me/delete/route";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

// Hoisted above route imports: replace the whole @/lib/auth module (pulling
// it in unmocked would drag next-auth's next/server import into vitest).
vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

const authState = testAuth;

function postReq(body: unknown, origin?: string) {
  return new Request("http://localhost:3000/api/turns", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  }) as any;
}

function getReq(query = "") {
  return new Request(`http://localhost:3000/api/turns${query}`) as any;
}

const uniqueSid = () => `sess-${Math.random().toString(36).slice(2, 12)}`;

beforeAll(async () => {});
beforeEach(async () => {
  await resetDb();
  authState.asA();
});

const sampleTurns = [
  { role: "user", text: "hi" },
  { role: "assistant", text: "hello!", latencyMs: 120 },
];

describe("POST /api/turns", () => {
  it("saves turns and returns them for the signed-in user", async () => {
    const sessionId = uniqueSid();
    const res = await turnsPost(postReq({ sessionId, mode: "gemini", turns: sampleTurns }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.turns).toHaveLength(2);
  });

  it("rejects missing sessionId with 400", async () => {
    const res = await turnsPost(postReq({ turns: [{ role: "user", text: "hi" }] }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid role with 400", async () => {
    const res = await turnsPost(postReq({ sessionId: uniqueSid(), turns: [{ role: "robot", text: "hi" }] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/role/i);
  });

  it("rejects more than 200 turns with 400", async () => {
    const turns = Array.from({ length: 201 }, () => ({ role: "user", text: "x" }));
    const res = await turnsPost(postReq({ sessionId: uniqueSid(), turns }));
    expect(res.status).toBe(400);
  });

  it("rejects negative latencyMs with 400", async () => {
    const res = await turnsPost(
      postReq({ sessionId: uniqueSid(), turns: [{ role: "user", text: "x", latencyMs: -5 }] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects cross-origin with 403", async () => {
    const res = await turnsPost(postReq({ sessionId: uniqueSid(), turns: sampleTurns }, "https://evil.example"));
    expect(res.status).toBe(403);
  });

  it("returns 401 when signed out", async () => {
    authState.signOut();
    const res = await turnsPost(postReq({ sessionId: uniqueSid(), turns: sampleTurns }));
    expect(res.status).toBe(401);
    authState.asA();
  });
});

describe("cross-user isolation", () => {
  it("user A cannot write into user B's session (and never sees B's turns)", async () => {
    const bSid = uniqueSid();
    authState.asB();
    await turnsPost(postReq({ sessionId: bSid, mode: "gemini", turns: [{ role: "user", text: "B private answer" }] }));

    authState.asA();
    const res = await turnsPost(postReq({ sessionId: bSid, turns: [{ role: "user", text: "injected by A" }] }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("B private answer");

    authState.asB();
    const own = await (await turnsGet(getReq(`?sessionId=${bSid}`))).json();
    expect(own.turns.map((t: any) => t.text)).toEqual(["B private answer"]);
  });

  it("user A cannot read user B's sessions", async () => {
    const bSid = uniqueSid();
    authState.asB();
    const saveRes = await turnsPost(postReq({ sessionId: bSid, mode: "gemini", turns: sampleTurns }));
    expect(saveRes.status).toBe(200);

    authState.asA();
    const listRes = await turnsGet(getReq());
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.sessions).not.toContain(bSid);
    expect(list.turns.filter((t: any) => t.sessionId === bSid)).toHaveLength(0);
  });

  it("user A gets 404 asking for user B's session by id", async () => {
    const bSid = uniqueSid();
    authState.asB();
    await turnsPost(postReq({ sessionId: bSid, mode: "gemini", turns: sampleTurns }));

    authState.asA();
    const res = await turnsGet(getReq(`?sessionId=${bSid}`));
    expect(res.status).toBe(404);
  });

  it("user B's rows still exist after A's read attempt", async () => {
    const bSid = uniqueSid();
    authState.asB();
    await turnsPost(postReq({ sessionId: bSid, mode: "browser", turns: sampleTurns }));

    authState.asA();
    await turnsGet(getReq());

    authState.asB();
    const res = await turnsGet(getReq(`?sessionId=${bSid}`));
    const data = await res.json();
    expect(data.turns).toHaveLength(2);
  });
});

describe("DELETE /api/me (delete my data)", () => {
  it("deletes the signed-in user's sessions and turns", async () => {
    const sid = uniqueSid();
    await turnsPost(postReq({ sessionId: sid, mode: "browser", turns: sampleTurns }));

    const res = await deleteMe();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.sessionsDeleted).toBeGreaterThan(0);

    const listRes = await turnsGet(getReq());
    const list = await listRes.json();
    expect(list.sessions).toHaveLength(0);
    expect(list.turns).toHaveLength(0);
  });

  it("leaves other users' data untouched", async () => {
    const aSid = uniqueSid();
    const bSid = uniqueSid();
    authState.asA();
    await turnsPost(postReq({ sessionId: aSid, mode: "browser", turns: sampleTurns }));
    authState.asB();
    await turnsPost(postReq({ sessionId: bSid, mode: "browser", turns: sampleTurns }));

    const res = await deleteMe(); // deletes B
    expect(res.status).toBe(200);

    authState.asA();
    const listRes = await turnsGet(getReq());
    const list = await listRes.json();
    expect(list.sessions).toContain(aSid);
    expect(list.sessions).not.toContain(bSid);
  });
});
