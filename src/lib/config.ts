// Server-side configuration, read from env with current values as defaults
// so a key or model rotation only needs an env change, not a code change.

export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";

export const CHAT_CONTEXT_TURNS = (() => {
  const n = Number(process.env.CHAT_CONTEXT_TURNS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8;
})();
