// Latency baseline for the text interview path (docs/metrics.md).
// Measures, over RUNS scripted interviews (1 opening turn + 3 answers each):
//   - time to first token  (POST /api/chat → first SSE `token` event)
//   - turn total           (POST /api/chat → `done`)
//   - report generation    (POST /api/interviews/{id}/end)
// and prints p50/p95. Live-voice first-audio is measured by hand from the
// latency pill on the interview page (see docs/metrics.md).
//
// Local only: signs in through the E2E test provider, so the server must run
// with E2E_TEST_AUTH=1 and a real GEMINI_API_KEY, against a seeded test DB.
//   E2E_TEST_AUTH=1 GEMINI_API_KEY=... DATABASE_URL=... npm start
//   BASE_URL=http://127.0.0.1:3000 RUNS=5 node scripts/measure-latency.mjs

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const RUNS = Number(process.env.RUNS ?? 5);

if (!["localhost", "127.0.0.1"].includes(new URL(BASE_URL).hostname)) {
  console.error("measure-latency: refusing to run against a non-local server");
  process.exit(1);
}

const ANSWERS = [
  "Connection pooling keeps database connections open and reuses them, which avoids a TCP and auth handshake per query.",
  "I would use two pointers moving at different speeds; if they meet there is a cycle, using constant memory.",
  "An index trades write cost and storage for faster reads by keeping a sorted structure over the indexed columns.",
];

// --- tiny cookie jar --------------------------------------------------------
const jar = new Map();
function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function http(path, init = {}) {
  const res = await fetch(BASE_URL + path, {
    redirect: "manual",
    ...init,
    headers: { ...(init.headers ?? {}), cookie: cookieHeader() },
  });
  storeCookies(res);
  return res;
}

async function signIn() {
  const csrfRes = await http("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const body = new URLSearchParams({ csrfToken, email: `latency-${Date.now()}@example.com`, callbackUrl: "/" });
  await http("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (![...jar.keys()].some((k) => k.includes("session-token"))) {
    throw new Error("sign-in failed: is the server running with E2E_TEST_AUTH=1?");
  }
}

// One /api/chat turn: returns { ttftMs, totalMs, interviewId, engine }.
async function chatTurn(payload) {
  const started = performance.now();
  const res = await http("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat ${res.status}`);
  const out = { ttftMs: null, totalMs: null, interviewId: payload.interviewId ?? null, engine: null, text: "" };
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const block of events) {
      const event = block.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? "null");
      if (event === "meta") {
        out.engine ??= data.engine;
        out.interviewId ??= data.interview_id ?? null;
      }
      if (event === "token") {
        out.ttftMs ??= performance.now() - started;
        out.text += data.text;
      }
      if (event === "error") throw new Error(`chat error: ${data.message}`);
      if (event === "done") out.totalMs = performance.now() - started;
    }
  }
  return out;
}

function pct(values, p) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return Math.round(v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]);
}

const samples = { ttft: [], turnTotal: [], report: [] };
const engines = new Set();

await signIn();
for (let run = 0; run < RUNS; run++) {
  const history = [];
  let turn = await chatTurn({ userText: "Hi, I'm ready to start.", interview: { role: "Backend Engineer", level: "mid" } });
  const interviewId = turn.interviewId;
  for (let i = 0; ; i++) {
    engines.add(turn.engine);
    samples.ttft.push(turn.ttftMs);
    samples.turnTotal.push(turn.totalMs);
    if (i === ANSWERS.length) break;
    history.push({ role: "assistant", text: turn.text || "…" });
    turn = await chatTurn({ userText: ANSWERS[i], history: history.slice(-20), interviewId });
    history.push({ role: "user", text: ANSWERS[i] });
  }
  const started = performance.now();
  const end = await http(`/api/interviews/${interviewId}/end`, { method: "POST", headers: { origin: BASE_URL } });
  if (!end.ok) throw new Error(`/end ${end.status}`);
  samples.report.push(performance.now() - started);
  console.error(`run ${run + 1}/${RUNS} done`);
}

const summary = {
  measuredAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  runs: RUNS,
  engines: [...engines],
  ttftMs: { p50: pct(samples.ttft, 50), p95: pct(samples.ttft, 95), n: samples.ttft.length },
  turnTotalMs: { p50: pct(samples.turnTotal, 50), p95: pct(samples.turnTotal, 95), n: samples.turnTotal.length },
  reportMs: { p50: pct(samples.report, 50), p95: pct(samples.report, 95), n: samples.report.length },
};
if (!summary.engines.includes("gemini")) {
  console.error("WARNING: no turn used the real model (engine != gemini); these numbers are NOT a baseline.");
}
console.log(JSON.stringify(summary, null, 2));
