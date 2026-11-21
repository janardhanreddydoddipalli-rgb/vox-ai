import Link from "next/link";

const STEPS = [
  {
    n: "1",
    title: "Choose your language",
    body: "English, हिन्दी, தமிழ் or తెలుగు. Pick a role and level, paste a job description, and Vox sets the stage in under a minute.",
  },
  {
    n: "2",
    title: "Talk. It listens.",
    body: "A real-time voice interview with follow-up questions — the interviewer hears a weak answer and probes deeper, like a real one.",
  },
  {
    n: "3",
    title: "Get your report",
    body: "A scored report with strengths, gaps and what to practise next, ready in seconds after you hang up.",
  },
];

export default function Landing() {
  return (
    <main className="landing">
      <header className="land-nav">
        <Link href="/" className="brand" aria-label="Vox home">
          <img src="/icons/vox-192.png" alt="" width={28} height={28} />
          <span>Vox</span>
        </Link>
        <nav aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#report">Sample report</a>
          <Link href="/privacy">Privacy</Link>
          <Link href="/dashboard" className="nav-signin">Sign in</Link>
        </nav>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">Vox launches today</p>
        <h1 id="hero-title">Speak. It listens. Your&nbsp;report is ready.</h1>
        <p className="hero-body">
          One 30-second clip says more than a page of features: a live Vox interview with
          follow-up questions, latency counters and the final scored report — in four Indian
          languages.
        </p>
        <div className="cta-row">
          <Link href="/new" className="btn-cta">Start a free interview</Link>
          <Link href="/playground" className="btn-ghost">Try the live demo</Link>
        </div>
      </section>

      <section className="demo" aria-label="Product demo">
        <video
          className="demo-video"
          src="/demo/vox-demo.mp4"
          poster="/generated/demo-poster.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
        <p className="demo-caption">A live Vox interview: follow-ups, latency and the scored report.</p>
      </section>

      <section id="how" className="how" aria-labelledby="how-title">
        <h2 id="how-title">Three steps, one conversation</h2>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.n} className="step">
              <span className="step-n" aria-hidden>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="report" className="proof" aria-labelledby="proof-title">
        <div className="proof-copy">
          <h2 id="proof-title">Proof before commitment</h2>
          <p>
            Every interview ends with a report you can act on: an overall score with a per-question
            breakdown, the strengths an interviewer would flag, the gaps you should close, and the
            exact follow-ups that exposed them.
          </p>
          <p className="proof-stat">
            <strong>3 questions · 5 minutes</strong> is all it takes — then the report is yours to
            share or delete, permanently, from your dashboard.
          </p>
          <Link href="/new" className="btn-cta">Start a free interview</Link>
        </div>
        <img
          className="proof-img"
          src="/generated/report-proof.jpg"
          alt="Sample Vox report: overall score ring with a per-question breakdown, strengths and gaps"
          width={600}
          height={800}
          loading="lazy"
        />
      </section>

      <footer className="land-footer">
        <span>© 2026 Vox</span>
        <nav aria-label="Footer">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <a href="https://code.ml.ai" rel="noopener">Built with ML AI Code</a>
        </nav>
      </footer>
    </main>
  );
}
