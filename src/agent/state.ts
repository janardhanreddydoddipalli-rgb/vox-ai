// Interview state: the thin service over the interview repository. Routes and
// tool handlers talk to this, never to Drizzle directly.
import {
  createInterview,
  getInterview,
  setInterviewStatus,
  bumpInterviewQuestion,
} from "@/lib/db/repository";

export type InterviewState = {
  id: string;
  role: string;
  level: string;
  status: string;
  currentQuestionIndex: number;
  language: string;
};

export async function startInterview(userId: string, role: string, level: string): Promise<InterviewState> {
  const row = await createInterview(userId, role, level);
  return {
    id: row.id,
    role: row.role,
    level: row.level,
    status: row.status,
    currentQuestionIndex: row.currentQuestionIndex,
    language: row.language ?? "en",
  };
}

// Ownership is enforced here: the caller must already know the user id.
export async function loadInterview(id: string, userId: string): Promise<InterviewState | null> {
  const row = await getInterview(id, userId);
  if (!row) return null;
  return {
    id: row.id,
    role: row.role,
    level: row.level,
    status: row.status,
    currentQuestionIndex: row.currentQuestionIndex,
    language: row.language ?? "en",
  };
}

export async function completeInterview(id: string, userId: string) {
  await setInterviewStatus(id, userId, "complete");
}

export async function advanceQuestion(id: string, userId: string) {
  const row = await bumpInterviewQuestion(id, userId);
  return row?.currentQuestionIndex ?? 0;
}
