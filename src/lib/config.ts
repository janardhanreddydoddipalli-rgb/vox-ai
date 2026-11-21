// Server-side configuration, read from env with current values as defaults
// so a key or model rotation only needs an env change, not a code change.

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

// Live voice model for the Gemini Live API (Phase 6). Separate from the text
// model: live sessions need a -live variant.
export const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL?.trim() || "models/gemini-3.1-flash-live-preview";

// Text-embedding model for memory + document retrieval (768 dims).
export const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001";

export const CHAT_CONTEXT_TURNS = (() => {
  const n = Number(process.env.CHAT_CONTEXT_TURNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
})();
