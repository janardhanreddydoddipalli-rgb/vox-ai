// Repository layer: the only place that touches the database. Route handlers
// call these functions; they never write SQL or Drizzle queries directly.
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { db, schema } from "./client";

const { users, sessions, turns, interviews, questions, agentSteps, resumes, interviewQa, userMemories, docChunks } = schema;

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
    // A missing name/image keeps the stored one (most callers pass only the email).
    .onConflictDoUpdate({
      target: users.email,
      set: { name: sql`coalesce(excluded.name, ${users.name})`, image: sql`coalesce(excluded.image, ${users.image})` },
    })
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

// --- interviews ----------------------------------------------------------
export type InterviewRow = typeof interviews.$inferSelect;

export async function createInterview(userId: string, role: string, level: string) {
  const [row] = await db.insert(interviews).values({ userId, role, level }).returning();
  return row;
}

export async function getInterview(id: string, userId: string) {
  const [row] = await db
    .select()
    .from(interviews)
    .where(and(eq(interviews.id, id), eq(interviews.userId, userId)))
    .limit(1);
  return row ?? null;
}

// Mutations are user-scoped: a foreign interview id updates nothing and
// returns null.
export async function setInterviewStatus(id: string, userId: string, status: "active" | "complete") {
  const [row] = await db
    .update(interviews)
    .set({ status })
    .where(and(eq(interviews.id, id), eq(interviews.userId, userId)))
    .returning();
  return row ?? null;
}

export async function bumpInterviewQuestion(id: string, userId: string, by = 1) {
  const [row] = await db
    .update(interviews)
    .set({ currentQuestionIndex: sql`${interviews.currentQuestionIndex} + ${by}` })
    .where(and(eq(interviews.id, id), eq(interviews.userId, userId)))
    .returning();
  return row ?? null;
}

// --- question bank ---------------------------------------------------------
export async function listQuestions() {
  return db.select().from(questions).orderBy(questions.id);
}

// --- agent tracing ---------------------------------------------------------
export type AgentStepInsert = {
  interviewId: string;
  stepIndex: number;
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
};

export async function addAgentStep(step: AgentStepInsert) {
  const [row] = await db.insert(agentSteps).values(step).returning();
  return row;
}

export async function getAgentSteps(interviewId: string) {
  return db.select().from(agentSteps).where(eq(agentSteps.interviewId, interviewId)).orderBy(agentSteps.createdAt, agentSteps.id);
}

// --- resumes ---------------------------------------------------------------
export async function saveResume(row: {
  userId: string;
  filename: string;
  rawText: string;
  skills: string[];
  projects: { name: string; summary: string }[];
  experience: { company: string; role: string; period: string | null }[];
}) {
  const [r] = await db.insert(resumes).values(row).returning();
  return r;
}

export async function getResume(id: string, userId: string) {
  const [r] = await db.select().from(resumes).where(and(eq(resumes.id, id), eq(resumes.userId, userId))).limit(1);
  return r ?? null;
}

// --- interview Q&A + reports ----------------------------------------------
// Appends an answered question at the next order number. The interview row
// is locked (FOR UPDATE) for the transaction, so concurrent saves for one
// interview serialise instead of both reading the same count; the unique
// (interview_id, order) index is the backstop.
export async function appendInterviewQa(row: {
  interviewId: string;
  questionId: string | null;
  questionText: string;
  answerText: string;
  evaluation: typeof interviewQa.$inferSelect.evaluation;
}) {
  return db.transaction(async (tx) => {
    await tx.select({ id: interviews.id }).from(interviews).where(eq(interviews.id, row.interviewId)).for("update");
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${interviewQa.order}) + 1, 0)::int` })
      .from(interviewQa)
      .where(eq(interviewQa.interviewId, row.interviewId));
    const [r] = await tx.insert(interviewQa).values({ ...row, order: next }).returning();
    return r;
  });
}

export async function listInterviewQa(interviewId: string) {
  return db.select().from(interviewQa).where(eq(interviewQa.interviewId, interviewId)).orderBy(interviewQa.order);
}

export async function saveInterviewReport(id: string, report: NonNullable<typeof interviews.$inferSelect.report>) {
  const [r] = await db
    .update(interviews)
    .set({ report, status: "complete", completedAt: new Date() })
    .where(eq(interviews.id, id))
    .returning();
  return r ?? null;
}

export async function listInterviews(userId: string) {
  return db.select().from(interviews).where(eq(interviews.userId, userId)).orderBy(desc(interviews.createdAt)).limit(50);
}

export async function latestQaScores(userId: string) {
  const rows = await db
    .select({ interviewId: interviewQa.interviewId, order: interviewQa.order, evaluation: interviewQa.evaluation, createdAt: interviewQa.createdAt })
    .from(interviewQa)
    .innerJoin(interviews, eq(interviewQa.interviewId, interviews.id))
    .where(eq(interviews.userId, userId))
    .orderBy(interviewQa.createdAt);
  return rows;
}

// --- memories + document chunks (pgvector) ---------------------------------
export type MemoryKind = "strength" | "weakness" | "preference";

// pgvector literal: '[0.12,0.34,...]'
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function createMemory(row: { userId: string; kind: MemoryKind; text: string; embedding: number[] }) {
  const [r] = await db
    .insert(userMemories)
    .values({ userId: row.userId, kind: row.kind, text: row.text, embedding: row.embedding })
    .returning({ id: userMemories.id, kind: userMemories.kind, text: userMemories.text, createdAt: userMemories.createdAt });
  return r;
}

export async function listMemories(userId: string) {
  return db
    .select({ id: userMemories.id, kind: userMemories.kind, text: userMemories.text, createdAt: userMemories.createdAt })
    .from(userMemories)
    .where(eq(userMemories.userId, userId))
    .orderBy(desc(userMemories.createdAt));
}

export async function getMemory(id: string, userId: string) {
  const [r] = await db
    .select({ id: userMemories.id })
    .from(userMemories)
    .where(and(eq(userMemories.id, id), eq(userMemories.userId, userId)))
    .limit(1);
  return r ?? null;
}

export async function deleteMemory(id: string, userId: string) {
  const [r] = await db
    .delete(userMemories)
    .where(and(eq(userMemories.id, id), eq(userMemories.userId, userId)))
    .returning({ id: userMemories.id });
  return r ?? null;
}

// All memories of one kind for a user (used to prioritise questions).
export async function listMemoriesByKind(userId: string, kind: MemoryKind, limit = 10) {
  return db
    .select({ id: userMemories.id, text: userMemories.text, createdAt: userMemories.createdAt })
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), eq(userMemories.kind, kind)))
    .orderBy(desc(userMemories.createdAt))
    .limit(limit);
}

// Nearest memories by cosine distance, scoped to one user. Raw SQL because
// pgvector's `<=>` operator is not part of Drizzle's query builder.
export async function findSimilarMemories(userId: string, embedding: number[], limit = 5, kinds?: MemoryKind[]) {
  const vec = vectorLiteral(embedding);
  const kindFilter = kinds && kinds.length > 0 ? sql` and kind = any(${kinds})` : sql``;
  const res = (await db.execute(
    sql`select id::text, kind, text, 1 - (embedding <=> ${vec}::vector) as similarity
        from user_memories
        where user_id = ${userId}${kindFilter}
        order by embedding <=> ${vec}::vector
        limit ${limit}`,
  )) as unknown as { id: string; kind: MemoryKind; text: string; similarity: string }[];
  return res.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
  }));
}

export async function createDocChunk(row: { userId: string; source: "resume" | "jd"; text: string; embedding: number[] }) {
  await db.insert(docChunks).values({ userId: row.userId, source: row.source, text: row.text, embedding: row.embedding });
}

// Replace a user's indexed chunks for one source (idempotent re-indexing).
export async function deleteDocChunksForUser(userId: string, source: "resume" | "jd") {
  await db.delete(docChunks).where(and(eq(docChunks.userId, userId), eq(docChunks.source, source)));
}

export async function searchDocChunks(userId: string, embedding: number[], limit = 5) {
  const vec = vectorLiteral(embedding);
  const res = (await db.execute(
    sql`select id::text, source, text, 1 - (embedding <=> ${vec}::vector) as similarity
        from doc_chunks
        where user_id = ${userId}
        order by embedding <=> ${vec}::vector
        limit ${limit}`,
  )) as unknown as { id: string; source: "resume" | "jd"; text: string; similarity: string }[];
  return res.map((r) => ({
    ...r,
    similarity: Number(r.similarity),
  }));
}

// --- deletion (privacy) --------------------------------------------------
// Deletes a user and everything they own. Turns are removed explicitly; the
// users row then cascades (ON DELETE CASCADE) to sessions, resumes,
// interviews (→ interview_qa, agent_steps), user_memories, doc_chunks and
// token_usage. Covered by tests/delete-user-data.test.ts across every table.
export async function deleteAllUserData(userId: string) {
  const owned = await sessionIdsForUser(userId);
  if (owned.length > 0) {
    await db.delete(turns).where(inArray(turns.sessionId, owned));
  }
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await deleteUser(userId);
  return owned.length;
}
