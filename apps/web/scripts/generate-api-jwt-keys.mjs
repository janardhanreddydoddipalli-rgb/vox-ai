// Generates the Ed25519 key pair for web → API tokens (ADR 0004).
//   node scripts/generate-api-jwt-keys.mjs
// Prints one-line env values (newlines escaped as \n):
//   API_JWT_PRIVATE_KEY → apps/web only (Vercel env / apps/web/.env.local)
//   JWT_PUBLIC_KEY      → services/api only
// Use a different pair per environment. The private key must never reach the API,
// the browser, logs or git.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const oneLine = (pem) => pem.trim().replace(/\n/g, "\\n");

console.log("# apps/web (secret: never commit)");
console.log(`API_JWT_PRIVATE_KEY=${oneLine(privateKey.export({ type: "pkcs8", format: "pem" }))}`);
console.log("");
console.log("# services/api (public)");
console.log(`JWT_PUBLIC_KEY=${oneLine(publicKey.export({ type: "spki", format: "pem" }))}`);
