import { z } from "zod";

// Shared request schemas. Handlers import these so the contract and the
// validation are the same code.

export const historyTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().max(2000),
  })
  .strip();

export const chatSchema = z
  .object({
    userText: z.string().trim().min(1, "userText is required").max(2000, "userText must be 2000 characters or fewer"),
    history: z.array(historyTurnSchema).max(20, "history must have at most 20 items").optional().default([]),
  })
  .strip();

export const savedTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(5000),
    latencyMs: z.number().finite().int().nonnegative().optional(),
    sttMs: z.number().finite().int().nonnegative().optional(),
    firstTokenMs: z.number().finite().int().nonnegative().optional(),
    totalLlmMs: z.number().finite().int().nonnegative().optional(),
    ttsStartMs: z.number().finite().int().nonnegative().optional(),
  })
  .strip();

export const turnsSchema = z
  .object({
    sessionId: z.string().min(1).max(64),
    mode: z.enum(["gemini", "browser"]).optional().default("browser"),
    turns: z.array(savedTurnSchema).max(200, "turns must have at most 200 items"),
  })
  .strip();

export type ChatRequest = z.infer<typeof chatSchema>;
export type TurnsRequest = z.infer<typeof turnsSchema>;

// Flatten a ZodError into one human-readable message for the 400 body.
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
