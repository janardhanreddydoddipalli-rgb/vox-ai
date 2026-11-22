import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { authConfig } from "@/lib/auth";

// The users row lives in services/api: the jwt callback resolves its id through
// /internal/users/upsert at sign-in, and the session exposes it as user.id.
const USER = "11111111-1111-4111-8111-111111111111";
const jwt = authConfig.callbacks!.jwt!;
const session = authConfig.callbacks!.session!;

const signIn = () => ({ token: {}, user: { email: "a@example.com", name: "Ada", image: "https://img/a.png" }, profile: undefined });

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Object.assign(process.env, { API_INTERNAL_URL: "http://api:8000/", INTERNAL_API_TOKEN: "svc-token" });
  fetchSpy = vi.fn(async () => Response.json({ user_id: USER }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  delete process.env.API_INTERNAL_URL;
  delete process.env.INTERNAL_API_TOKEN;
  vi.unstubAllGlobals();
});

describe("Auth.js callbacks", () => {
  it("resolves the users.id at sign-in with the service credential", async () => {
    const token = await jwt(signIn() as never);

    expect(token).toMatchObject({ email: "a@example.com", userId: USER });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api:8000/internal/users/upsert");
    expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe("svc-token");
    expect(JSON.parse(String(init.body))).toEqual({ email: "a@example.com", name: "Ada", image: "https://img/a.png" });
  });

  it("asks once: a token that already has the id makes no call", async () => {
    await jwt({ token: { email: "a@example.com", userId: USER } } as never);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fills the id for a session started before it was kept in the token", async () => {
    const token = await jwt({ token: { email: "a@example.com", name: "Ada" } } as never);
    expect(token).toMatchObject({ userId: USER });
  });

  it("fails sign-in when the API can't resolve the user (the app can't work without it)", async () => {
    fetchSpy.mockResolvedValue(new Response("down", { status: 503 }));
    await expect(jwt(signIn() as never)).rejects.toThrow("internal user upsert failed: 503");
  });

  it("exposes the users.id as session.user.id, never the OAuth account id", async () => {
    const out = await session({ session: { user: { id: "google-sub", email: "a@example.com" } }, token: { sub: "google-sub", userId: USER } } as never);
    expect((out as { user: { id: string } }).user.id).toBe(USER);
  });
});
