import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { upsertUserByEmail, listSessions, getTurnsForSessions, listInterviews, latestQaScores } from "@/lib/db";
import DashboardClient from "./dashboard-client";

// Server component: load the signed-in user's own history only.
export default async function Dashboard() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/");

  const user = await upsertUserByEmail(email);
  const sessions = user ? await listSessions(user.id) : [];
  const turns = await getTurnsForSessions(sessions.map((s) => s.id));
  const interviews = user ? await listInterviews(user.id) : [];
  const qaScores = user ? await latestQaScores(user.id) : [];

  return (
    <main>
      <DashboardClient
        email={email}
        sessions={sessions.map((s) => ({ id: s.id, mode: s.mode, createdAt: s.createdAt.toISOString() }))}
        turns={turns.map((t) => ({
          sessionId: t.sessionId,
          role: t.role,
          text: t.text,
          latencyMs: t.latencyMs,
          createdAt: t.createdAt.toISOString(),
        }))}
        interviews={interviews.map((iv) => ({
          id: iv.id,
          role: iv.role,
          level: iv.level,
          status: iv.status,
          overall: iv.report?.overall ?? null,
          createdAt: iv.createdAt.toISOString(),
        }))}
        qaScores={qaScores.map((q) => ({
          interviewId: q.interviewId,
          order: q.order,
          score: q.evaluation?.score ?? null,
          createdAt: q.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
