import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The browser keeps the /api/token JWT in memory, reuses it until shortly
// before it expires, and shares one request between concurrent callers.
let fetchSpy: ReturnType<typeof vi.fn>;
let issued = 0;

async function load() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_API_URL = "http://api.test/";
  return import("@/lib/api-browser");
}

beforeEach(() => {
  issued = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  fetchSpy = vi.fn(async (url: string) => {
    if (url === "/api/token") return Response.json({ token: `t${++issued}`, expires_in: 300 });
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api-browser token cache", () => {
  it("reuses the token until 30 s before it expires", async () => {
    const { apiToken } = await load();
    expect(await apiToken()).toBe("t1");
    vi.setSystemTime(Date.now() + 269_000);
    expect(await apiToken()).toBe("t1");
    vi.setSystemTime(Date.now() + 2_000);
    expect(await apiToken()).toBe("t2");
  });

  it("shares one /api/token request between concurrent callers", async () => {
    const { apiToken } = await load();
    expect(await Promise.all([apiToken(), apiToken(), apiToken()])).toEqual(["t1", "t1", "t1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("signed out is a SignedOutError, and nothing is cached", async () => {
    const { apiToken, currentToken, SignedOutError } = await load();
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(apiToken()).rejects.toBeInstanceOf(SignedOutError);
    expect(currentToken()).toBeNull();
  });

  it("apiFetch sends the bearer token to the API origin", async () => {
    const { apiFetch } = await load();
    await apiFetch("/v1/chat", { method: "POST" });
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("http://api.test/v1/chat");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t1");
  });
});
