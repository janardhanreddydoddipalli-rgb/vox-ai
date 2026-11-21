import { describe, it, expect, afterEach, vi } from "vitest";

// AUTH_UPSERT_VIA_API (default off): at sign-in, the jwt callback asks
// services/api for the stable user id. Off must change nothing.
const ENV = ["AUTH_UPSERT_VIA_API", "API_INTERNAL_URL", "INTERNAL_API_TOKEN"] as const;

async function jwtCallback() {
  vi.resetModules();
  const { authConfig } = await import("@/lib/auth");
  return authConfig.callbacks!.jwt!;
}

const signIn = () => ({ token: {}, user: { email: "a@example.com", name: "Ada", image: "https://img/a.png" }, profile: undefined });

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("Auth.js jwt callback: AUTH_UPSERT_VIA_API", () => {
  it("is off by default: no API call, no userId", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const token = await (await jwtCallback())(signIn() as never);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(token).not.toHaveProperty("userId");
    expect(token).toMatchObject({ email: "a@example.com" });
  });

  it("when on, upserts through /internal/users/upsert with the service credential", async () => {
    Object.assign(process.env, { AUTH_UPSERT_VIA_API: "1", API_INTERNAL_URL: "http://api:8000/", INTERNAL_API_TOKEN: "svc-token" });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ user_id: "11111111-1111-4111-8111-111111111111" })));
    vi.stubGlobal("fetch", fetchSpy);

    const token = await (await jwtCallback())(signIn() as never);

    expect(token).toMatchObject({ userId: "11111111-1111-4111-8111-111111111111" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api:8000/internal/users/upsert");
    expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe("svc-token");
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@example.com", name: "Ada", image: "https://img/a.png" });
  });

  it("when on, an API failure does not block sign-in", async () => {
    Object.assign(process.env, { AUTH_UPSERT_VIA_API: "1", API_INTERNAL_URL: "http://api:8000", INTERNAL_API_TOKEN: "svc-token" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const token = await (await jwtCallback())(signIn() as never);

    expect(token).toMatchObject({ email: "a@example.com" });
    expect(token).not.toHaveProperty("userId");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
