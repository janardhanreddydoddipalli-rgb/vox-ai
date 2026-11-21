import { pgTable, uuid, text, integer, timestamp, index, foreignKey, jsonb, vector } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("browser"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const resumes = pgTable(
  "resumes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    rawText: text("raw_text").notNull(),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    projects: jsonb("projects").$type<{ name: string; summary: string }[]>().notNull().default([]),
    experience: jsonb("experience").$type<{ company: string; role: string; period: string | null }[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resumes_user_id_idx").on(t.userId)],
);

export const interviews = pgTable(
  "interviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    level: text("level").notNull(),
    status: text("status").notNull().default("active"), // active | complete
    currentQuestionIndex: integer("current_question_index").notNull().default(0),
    resumeId: uuid("resume_id").references(() => resumes.id, { onDelete: "set null" }),
    jobDescription: text("job_description"),
    report: jsonb("report").$type<ReportJson | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("interviews_user_id_idx").on(t.userId)],
);

export type ReportJson = {
  overall: number;
  strengths: string[];
  gaps: string[];
  summary: string;
  perQuestion?: { question: string; score: number; better_answer: string }[];
};

// One asked question with the candidate's answer and its evaluation.
export const interviewQa = pgTable(
  "interview_qa",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    questionId: text("question_id"),
    questionText: text("question_text").notNull(),
    answerText: text("answer_text").notNull(),
    evaluation: jsonb("evaluation").$type<{
      score: number;
      clarity: string;
      depth: string;
      correctness: string;
      missing_points: string[];
      follow_up_needed: boolean;
      follow_up_question?: string;
      better_answer?: string;
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interview_qa_interview_id_idx").on(t.interviewId)],
);

export const questions = pgTable("questions", {
  id: uuid("id").defaultRandom().primaryKey(),
  category: text("category").notNull(), // frontend | backend | dsa | hr
  text: text("text").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    interviewId: uuid("interview_id")
      .notNull()
      .references(() => interviews.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    toolName: text("tool_name").notNull(),
    input: jsonb("input").notNull(),
    output: jsonb("output").notNull(),
    durationMs: integer("duration_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_steps_interview_id_idx").on(t.interviewId)],
);

// Long-term memory learned from past interviews. Embeddings are Gemini
// embeddings at 768 dimensions; cosine search runs in pgvector.
export const userMemories = pgTable(
  "user_memories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // strength | weakness | preference
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_memories_user_id_idx").on(t.userId)],
);

// Chunks of the candidate's own documents (resume, job description) for
// retrieval during interviews.
export const docChunks = pgTable(
  "doc_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // resume | jd
    text: text("text").notNull(),
    embedding: vector("embedding", { dimensions: 768 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("doc_chunks_user_id_idx").on(t.userId)],
);

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: text("session_id").notNull(),
    role: text("role").notNull(),
    text: text("text").notNull(),
    latencyMs: integer("latency_ms"),
    sttMs: integer("stt_ms"),
    firstTokenMs: integer("first_token_ms"),
    totalLlmMs: integer("total_llm_ms"),
    ttsStartMs: integer("tts_start_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.sessionId],
      foreignColumns: [sessions.id],
      name: "turns_session_fk",
    }).onDelete("cascade"),
    index("turns_session_id_idx").on(t.sessionId),
  ],
);
