import { currentUserId } from "@/lib/auth";
import { loadReportView } from "@/lib/interviews";
import Link from "next/link";
import { redirect } from "next/navigation";
import PdfButton from "./pdf-button";

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await currentUserId();
  if (!userId) redirect("/signin");

  const view = await loadReportView(userId, id);
  if (!view) {
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

  const { iv, qa } = view;
  if (iv.status !== "complete" || !iv.report) {
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
        <PdfButton interviewId={id} />
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
