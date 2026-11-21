// Dev-only trace viewer: the step timeline for one interview. Server
// component; renders in dev only, scoped to the signed-in user.
import { auth } from "@/lib/auth";
import { upsertUserByEmail } from "@/lib/db";
import { loadAgentSteps } from "@/lib/interviews";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DebugInterviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV !== "development") {
    return <p>Debug pages are available in development only.</p>;
  }
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.email) redirect("/signin");
  // users.id, not session.user.id (that is the OAuth account id and never matched).
  const user = await upsertUserByEmail(session.user.email);
  const steps = user ? await loadAgentSteps(user.id, id) : null;
  if (!steps) {
    return <p style={{ padding: 24 }}>No interview with that id for your account.</p>;
  }

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, fontFamily: "var(--font-mono, monospace)" }}>
      <h1 style={{ fontSize: 20 }}>Interview trace</h1>
      <p>
        {id} — {steps.length} tool step{steps.length === 1 ? "" : "s"}
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
