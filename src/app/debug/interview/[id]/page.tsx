// Dev-only trace viewer: the step timeline for one interview. Server
// component; renders in dev only, scoped to the signed-in user.
import { auth } from "@/lib/auth";
import { getAgentSteps } from "@/lib/db/repository";
import { loadInterview } from "@/agent/state";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DebugInterviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV !== "development") {
    return <p>Debug pages are available in development only.</p>;
  }
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.email) redirect("/signin");
  const interview = await loadInterview(id, session.user.id!);
  if (!interview) {
    return <p style={{ padding: 24 }}>No interview with that id for your account.</p>;
  }
  const steps = await getAgentSteps(id);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, fontFamily: "var(--font-mono, monospace)" }}>
      <h1 style={{ fontSize: 20 }}>Interview trace</h1>
      <p>
        {interview.id} — role: {interview.role} · level: {interview.level} · status: {interview.status} · question #
        {interview.currentQuestionIndex}
      </p>
      {steps.length === 0 ? (
        <p>No tool steps recorded yet.</p>
      ) : (
        <ol style={{ paddingLeft: 20, lineHeight: 1.6 }}>
          {steps.map((s) => (
            <li key={s.id} style={{ marginBottom: 16 }}>
              <strong>#{s.stepIndex} {s.toolName}</strong>{" "}
              <span style={{ color: "#888" }}>{s.durationMs} ms</span>
              <pre style={{ whiteSpace: "pre-wrap", background: "var(--surface-2, #f4f4f5)", padding: 8, borderRadius: 8, fontSize: 12 }}>
                in: {JSON.stringify(s.input)}
              </pre>
              <pre style={{ whiteSpace: "pre-wrap", background: "var(--surface-2, #f4f4f5)", padding: 8, borderRadius: 8, fontSize: 12 }}>
                out: {JSON.stringify(s.output)}
              </pre>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
