// Repository layer: the only place that touches the database. Route handlers
// call these functions; they never write SQL or Drizzle queries directly.
import { eq, desc, and, inArray } from "drizzle-orm";
import { db, schema } from "./client";

const { users, sessions, turns } = schema;

export type Mode = "gemini" | "browser";
export type TurnRow = {
  id: string;
  sessionId: string;
  role: string;
  text: string;
  latencyMs: number | null;
  sttMs: number | null;
  firstTokenMs: number | null;
  totalLlmMs: number | null;
  ttsStartMs: number | null;
  createdAt: Date;
};

// --- users -------------------------------------------------------------
export async function upsertUserByEmail(email: string, name?: string | null, image?: string | null) {
  const [row] = await db
    .insert(users)
    .values({ email, name: name ?? null, image: image ?? null })
    .onConflictDoUpdate({ target: users.email, set: { name: name ?? null, image: image ?? null } })
    .returning();
  return row;
}

export async function getUserById(id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function deleteUser(id: string) {
  const [row] = await db.delete(users).where(eq(users.id, id)).returning();
  return row ?? null;
}

// --- sessions ----------------------------------------------------------
export async function ensureSession(userId: string | null, sessionId: string, mode: Mode) {
  await db
    .insert(sessions)
    .values({ id: sessionId, userId, mode })
    .onConflictDoNothing({ target: sessions.id });
}

// All sessions belonging to one user, newest first.
export async function listSessions(userId: string) {
  return db.select().from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt));
}

// --- turns -------------------------------------------------------------
export type TurnInsert = {
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  latencyMs?: number;
  sttMs?: number;
  firstTokenMs?: number;
  totalLlmMs?: number;
  ttsStartMs?: number;
};

function toRow(sessionId: string, r: TurnInsert) {
  return {
    sessionId,
    role: r.role,
    text: r.text,
    latencyMs: r.latencyMs ?? null,
    sttMs: r.sttMs ?? null,
    firstTokenMs: r.firstTokenMs ?? null,
    totalLlmMs: r.totalLlmMs ?? null,
    ttsStartMs: r.ttsStartMs ?? null,
  };
}

export async function addTurn(sessionId: string, r: TurnInsert) {
  const [row] = await db.insert(turns).values(toRow(sessionId, r)).returning();
  return row;
}

export async function addTurns(rows: TurnInsert[]) {
  if (rows.length === 0) return [];
  return db.insert(turns).values(rows.map((r) => toRow(r.sessionId, r))).returning();
}

// Turns for sessions the user owns — ownership is enforced by the session list.
export async function getTurnsForSessions(sessionIds: string[]): Promise<TurnRow[]> {
  if (sessionIds.length === 0) return [];
  const rows = await db.select().from(turns).where(inArray(turns.sessionId, sessionIds)).orderBy(turns.createdAt);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    role: r.role,
    text: r.text,
    latencyMs: r.latencyMs,
    sttMs: r.sttMs,
    firstTokenMs: r.firstTokenMs,
    totalLlmMs: r.totalLlmMs,
    ttsStartMs: r.ttsStartMs,
    createdAt: r.createdAt,
  }));
}

// A user's own session ids, for scoping reads and deletes.
export async function sessionIdsForUser(userId: string): Promise<string[]> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  return rows.map((r) => r.id);
}

// Ownership check: does this session belong to this user?
export async function sessionOwnedBy(sessionId: string, userId: string) {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1);
  return row != null;
}

// --- deletion (privacy) --------------------------------------------------
// Deletes a user and, via ON DELETE CASCADE, their sessions and turns.
export async function deleteAllUserData(userId: string) {
  const owned = await sessionIdsForUser(userId);
  if (owned.length > 0) {
    await db.delete(turns).where(inArray(turns.sessionId, owned));
  }
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await deleteUser(userId);
  return owned.length;
}
