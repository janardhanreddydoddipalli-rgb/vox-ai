import { auth } from "@/lib/auth";
import { upsertUserByEmail, getInterview, listInterviewQa } from "@/lib/db";
import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.email) redirect("/signin");
  const user = await upsertUserByEmail(session.user.email);
  if (!user) redirect("/signin");

  const iv = await getInterview(id, user.id);
  if (!iv) {
    return (
      <main className="report-page">
        <div className="card state-card">
          <h1>Report not found</h1>
          <p>We couldn&apos;t find that interview for your account.</p>
          <Link className="btn btn-primary" href="/dashboard">Back to dashboard</Link>
        </div>
      </main>
    );
  }

  if (iv.status !== "complete") {
    return (
      <main className="report-page">
        <div className="card state-card">
          <h1>Interview still in progress</h1>
          <p>End the interview to generate its report.</p>
          <Link className="btn btn-primary" href={`/interview/${id}`}>Back to interview</Link>
        </div>
      </main>
    );
  }

  const report = iv.report;
  const qa = await listInterviewQa(id);
  const h = await headers();
  const scheme = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  const pdfHref = `${scheme}://${host}/api/interviews/${id}/report.pdf`;

  if (!report) {
    return (
      <main className="report-page">
        <div className="card state-card">
          <h1>Report not generated yet</h1>
          <p>The report for this interview hasn&apos;t been written. End the interview to create it.</p>
          <Link className="btn btn-primary" href={`/interview/${id}`}>Back to interview</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="report-page">
      <header className="report-head">
        <div>
          <h1>Interview report</h1>
          <p className="report-sub">
            {iv.role} · {iv.level} · {new Date(iv.createdAt).toLocaleDateString()}
          </p>
        </div>
        <a className="btn btn-secondary" href={pdfHref} download={`vox-interview-${id.slice(0, 8)}.pdf`}>
          Download PDF
        </a>
      </header>

      <section className="score-band" aria-label="Overall score">
        <div className="score-big tabular">{report.overall.toFixed(1)}</div>
        <div className="score-meta">
          <p className="report-summary">{report.summary}</p>
        </div>
      </section>

      <div className="report-cols">
        <section className="card">
          <h2>Strengths</h2>
          {report.strengths.length ? (
            <ul>{report.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
          ) : (
            <p className="empty-note">Nothing stood out yet — complete more answers next time.</p>
          )}
        </section>
        <section className="card">
          <h2>Gaps</h2>
          {report.gaps.length ? (
            <ul>{report.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
          ) : (
            <p className="empty-note">No gaps recorded.</p>
          )}
        </section>
      </div>

      <section>
        <h2 className="report-qh">Question by question</h2>
        {qa.length === 0 && <p className="empty-note">No questions were answered in this interview.</p>}
        {qa.map((q, i) => {
          const better = report.perQuestion?.[i]?.better_answer;
          return (
            <article className="card qa-card" key={q.id}>
              <div className="qa-head">
                <h3>Q{i + 1}. {q.questionText}</h3>
                <span className="score-chip tabular">{q.evaluation?.score ?? "–"}/10</span>
              </div>
              <p className="qa-answer">“{q.answerText}”</p>
              {q.evaluation && (
                <ul className="qa-notes">
                  <li>{q.evaluation.clarity}</li>
                  <li>{q.evaluation.depth}</li>
                  <li>{q.evaluation.correctness}</li>
                </ul>
              )}
              {q.evaluation?.missing_points != null && q.evaluation.missing_points.length > 0 && (
                <p className="qa-missing">Missing: {q.evaluation.missing_points.join("; ")}</p>
              )}
              {better && (
                <details className="qa-better">
                  <summary>A better sample answer</summary>
                  <p>{better}</p>
                </details>
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
