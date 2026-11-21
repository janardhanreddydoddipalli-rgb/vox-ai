// Short-lived tokens for calling services/api (ADR 0004). The web app holds
// the EdDSA PRIVATE key; the API verifies with the public key only.
import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import { randomUUID } from "node:crypto";

export const API_TOKEN_TTL_SECONDS = 300;
export const API_TOKEN_ISSUER = "vox-web";
export const API_TOKEN_AUDIENCE = "vox-api";

let cached: { pem: string; key: Promise<CryptoKey> } | null = null;

function signingKey(): Promise<CryptoKey> | null {
  const raw = process.env.API_JWT_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const pem = raw.replace(/\\n/g, "\n"); // env files often hold PEMs on one line
  if (cached?.pem !== pem) cached = { pem, key: importPKCS8(pem, "EdDSA") };
  return cached.key;
}

export function apiTokensConfigured(): boolean {
  return Boolean(process.env.API_JWT_PRIVATE_KEY?.trim());
}

// sub is the users.id UUID: the API looks the user up by it.
export async function mintApiToken(userId: string): Promise<string> {
  const key = signingKey();
  if (!key) throw new Error("API_JWT_PRIVATE_KEY is not set");
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(API_TOKEN_ISSUER)
    .setAudience(API_TOKEN_AUDIENCE)
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${API_TOKEN_TTL_SECONDS}s`)
    .sign(await key);
}
