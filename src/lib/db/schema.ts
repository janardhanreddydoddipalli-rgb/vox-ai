import { pgTable, uuid, text, integer, timestamp, index, foreignKey, jsonb } from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interviews_user_id_idx").on(t.userId)],
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
