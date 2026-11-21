import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as chatPost } from "@/app/api/chat/route";
import { mockGeminiFailure } from "./gemini-mock";
import { resetDb } from "./setup";
import { testAuth } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

// Privacy rule: never log transcripts. Logs may carry ids and lengths only.
const SECRET = "my-private-answer-7f3a";
const spies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(async () => {
  await resetDb();
  testAuth.asA();
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  }
});

afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
});

describe("/api/chat logging", () => {
  it("the offline fallback never writes the user's text to logs", async () => {
    mockGeminiFailure(500);
    const res = await chatPost(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: `hello ${SECRET}`, history: [] }),
      }) as any,
    );
    await res.text(); // drain the SSE stream so every log call has happened
    const logged = spies.flatMap((s) => s.mock.calls.map((args: unknown[]) => args.map(String).join(" ")));
    expect(logged.length).toBeGreaterThan(0); // the fallback is still logged…
    expect(logged.join("\n")).not.toContain(SECRET); // …without the transcript
  });
});
