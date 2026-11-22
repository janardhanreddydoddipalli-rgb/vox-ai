import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Signed-in state for the edge auth used by middleware.
const session = vi.hoisted(() => ({ current: null as null | { user: { email: string } } }));
vi.mock("@/lib/auth-edge", () => ({ middlewareAuth: async () => session.current }));

import middleware from "@/middleware";

const req = (path: string) => new NextRequest(new URL(path, "http://localhost:3000"));

beforeEach(() => {
  session.current = null;
});

describe("middleware", () => {
  it("redirects signed-out page visits to /signin with a callbackUrl", async () => {
    const res = await middleware(req("/dashboard"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/signin");
    expect(location.searchParams.get("callbackUrl")).toBe("/dashboard");
  });

  it("keeps the full path and query in callbackUrl", async () => {
    const res = await middleware(req("/dashboard/history?tab=reports"));
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("callbackUrl")).toBe("/dashboard/history?tab=reports");
  });

  it("still answers signed-out API calls with a JSON 401 (no redirect)", async () => {
    const res = await middleware(req("/api/token"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("leaves public API paths open", async () => {
    for (const path of ["/api/auth/session", "/api/auth/csrf"]) {
      const res = await middleware(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("lets signed-in users through", async () => {
    session.current = { user: { email: "user-a@example.com" } };
    for (const path of ["/dashboard", "/api/token"]) {
      const res = await middleware(req(path));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
