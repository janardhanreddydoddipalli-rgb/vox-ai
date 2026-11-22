import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { vi } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify, decodeProtectedHeader, type CryptoKey } from "jose";
import { GET as tokenGet } from "@/app/api/token/route";
import { testAuth, USER_A } from "./auth-mock";

vi.mock("@/lib/auth", async () => {
  const { makeAuthMock } = await import("./auth-mock");
  return makeAuthMock();
});

let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  publicKey = pair.publicKey;
  // Stored the way the docs say: one line with escaped newlines.
  process.env.API_JWT_PRIVATE_KEY = (await exportPKCS8(pair.privateKey)).trim().replace(/\n/g, "\\n");
  expect((await exportSPKI(pair.publicKey)).startsWith("-----BEGIN PUBLIC KEY-----")).toBe(true);
});

beforeEach(() => {
  testAuth.asA();
});

describe("GET /api/token", () => {
  it("mints a 5-minute EdDSA token for the session's users.id", async () => {
    const res = await tokenGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { token, expires_in } = await res.json();
    expect(expires_in).toBe(300);

    expect(decodeProtectedHeader(token).alg).toBe("EdDSA");
    const { payload } = await jwtVerify(token, publicKey, { issuer: "vox-web", audience: "vox-api" });
    expect(payload.sub).toBe(USER_A);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("gives every token a unique jti", async () => {
    const a = (await (await tokenGet()).json()).token;
    const b = (await (await tokenGet()).json()).token;
    const [pa, pb] = await Promise.all([jwtVerify(a, publicKey), jwtVerify(b, publicKey)]);
    expect(pa.payload.jti).not.toBe(pb.payload.jti);
  });

  it("rejects signed-out callers with 401", async () => {
    testAuth.signOut();
    expect((await tokenGet()).status).toBe(401);
  });

  it("answers 503 when the signing key is not configured", async () => {
    const saved = process.env.API_JWT_PRIVATE_KEY;
    delete process.env.API_JWT_PRIVATE_KEY;
    try {
      expect((await tokenGet()).status).toBe(503);
    } finally {
      process.env.API_JWT_PRIVATE_KEY = saved;
    }
  });
});
