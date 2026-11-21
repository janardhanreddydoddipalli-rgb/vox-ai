// Vox eval runner (Phase 7 step 3): 20 scripted candidate conversations —
// weak, average, strong — run against the real model and the real agent loop.
//
// Checks per case:
//  1. follow-up asked on weak answers (evaluate_answer must set follow_up_needed)
//  2. score within the case's expected range
//  3. no invented questions — every question in the spoken reply must come
//     from a tool output (get_question text or the tool's follow_up_question)
//  4. step limit respected (never hit MAX_TOOL_STEPS)
//  5. reply length suitable for speech (<= MAX_SPOKEN_WORDS words, no markdown)
//
// Output: per-tag pass rates, tokens, cost (USD est.) and latency; exit 1 when
// the pass rate is below EVAL_PASS_THRESHOLD (default 0.9).
import "./env";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { runAgentLoop, MAX_TOOL_STEPS, type LoopMessage } from "@/agent/loop";
import { evaluateWithGemini } from "@/agent/tools/interview-tools";
import { INTERVIEWER_SYSTEM_PROMPT } from "@/agent/prompt";
import "@/agent/tools/all";
import { db } from "@/lib/db";
import { users, questions } from "@/lib/db/schema";
import { QUESTION_BANK } from "@/agent/questions-bank";
import { startInterview } from "@/agent/state";
import { estimateCost } from "@/lib/tracing";

type Case = {
  id: string;
  tag: "weak" | "average" | "strong";
  category: string;
  question: string;
  answer: string;
  expected_score_min: number;
  expected_score_max: number;
  expect_follow_up: boolean;
};

const MAX_SPOKEN_WORDS = 80;
const CONCURRENCY = 3;
const PASS_THRESHOLD = Number(process.env.EVAL_PASS_THRESHOLD ?? "0.9");

const CASES: Case[] = readFileSync(new URL("./dataset.jsonl", import.meta.url), "utf8")
  .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

type CheckResult = { name: string; pass: boolean; detail: string };
type CaseResult = {
  id: string;
  tag: Case["tag"];
  passed: boolean;
  checks: CheckResult[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
};

// Normalize for "no invented questions": collapse whitespace/punctuation so a
// spoken paraphrase of the same question sentence still matches.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

// Question-like sentences in the reply (ends with ?, or starts with an
// interrogative and ends with .).
function questionSentences(reply: string): string[] {
  return reply.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter((s) => /[?]$/.test(s) || /^(what|how|why|tell me|can you|could you|walk me)\b/i.test(s));
}

// Collect every question text any tool returned for this loop result.
function toolQuestions(steps: { toolName: string; output: unknown }[]): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const o = s.output as Record<string, unknown> | undefined;
    if (!o) continue;
    if (typeof o.question === "string") out.push(o.question);
    if (typeof o.follow_up_question === "string") out.push(o.follow_up_question);
  }
  return out;
}

function spokenLengthCheck(reply: string): CheckResult {
  const words = reply.split(/\s+/).filter(Boolean).length;
  const markdown = /(^|\n)\s*[-*#>]|\*\*/.test(reply);
  const pass = words <= MAX_SPOKEN_WORDS && !markdown;
  return { name: "reply-length-speech", pass, detail: `${words} words, markdown=${markdown}` };
}

function noInventedQuestionsCheck(reply: string, steps: { toolName: string; output: unknown }[]): CheckResult {
  const allowed = toolQuestions(steps).map(norm);
  const asked = questionSentences(reply);
  const invented = asked.filter((q) => !allowed.some((a) => a.includes(norm(q)) || norm(q).includes(a)));
  return {
    name: "no-invented-questions",
    pass: invented.length === 0,
    detail: asked.length === 0 ? "no questions asked" : invented.length === 0 ? `all ${asked.length} question(s) tool-sourced` : `invented: ${invented.join(" | ").slice(0, 160)}`,
  };
}

async function runCase(testCase: Case, userId: string): Promise<CaseResult> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  // --- Slice A: the grading model's score and follow-up decision ------------
  let evaluation: Awaited<ReturnType<typeof evaluateWithGemini>> | null = null;
  try {
    evaluation = await evaluateWithGemini(testCase.question, testCase.answer);
    const inRange = evaluation.score >= testCase.expected_score_min && evaluation.score <= testCase.expected_score_max;
    checks.push({ name: "score-in-range", pass: inRange, detail: `score ${evaluation.score}, expected ${testCase.expected_score_min}-${testCase.expected_score_max}` });
    const followOk = evaluation.follow_up_needed === testCase.expect_follow_up;
    checks.push({ name: "follow-up-policy", pass: followOk, detail: `follow_up_needed=${evaluation.follow_up_needed}, expected=${testCase.expect_follow_up}` });
  } catch (e) {
    checks.push({ name: "score-in-range", pass: false, detail: `evaluateWithGemini failed: ${e instanceof Error ? e.message : e}` });
    checks.push({ name: "follow-up-policy", pass: false, detail: "evaluation failed" });
  }

  // --- Slice B: the agent loop's behaviour over a fresh interview -----------
  const iv = await startInterview(userId, testCase.category === "hr" ? "HR" : "Engineer", "mid");
  let loopSteps: { toolName: string; output: unknown }[] = [];
  try {
    // Turn 1: ask the opening question.
    const turn1 = await runAgentLoop("Start the interview", [], INTERVIEWER_SYSTEM_PROMPT, {}, { userId, interviewId: iv.id });
    tokensIn += turn1.tokensIn; tokensOut += turn1.tokensOut; loopSteps = loopSteps.concat(turn1.steps);

    // Turn 2: the scripted answer.
    const history: LoopMessage[] = [
      { role: "user", text: "Start the interview" },
      { role: "model", text: turn1.reply },
    ];
    const turn2 = await runAgentLoop(testCase.answer, history, INTERVIEWER_SYSTEM_PROMPT, {}, { userId, interviewId: iv.id });
    tokensIn += turn2.tokensIn; tokensOut += turn2.tokensOut; loopSteps = loopSteps.concat(turn2.steps);

    checks.push({ name: "step-limit", pass: !turn1.hitStepLimit && !turn2.hitStepLimit && turn1.steps.length <= MAX_TOOL_STEPS && turn2.steps.length <= MAX_TOOL_STEPS, detail: `steps t1=${turn1.steps.length} t2=${turn2.steps.length} cap=${MAX_TOOL_STEPS}` });
    const reply = turn2.reply;
    checks.push(spokenLengthCheck(reply));
    checks.push(noInventedQuestionsCheck(reply, loopSteps));

    if (testCase.expect_follow_up && evaluation) {
      const asked = /(\?|follow)/i.test(reply) && (evaluation.follow_up_needed === false || questionSentences(reply).length > 0);
      checks.push({ name: "weak-follow-up-asked", pass: asked, detail: asked ? "follow-up present in reply" : `reply had no follow-up (follow_up_needed=${evaluation.follow_up_needed})` });
    }
  } catch (e) {
    checks.push({ name: "loop-ran", pass: false, detail: `runAgentLoop failed: ${e instanceof Error ? e.message : e}` });
  }

  const passed = checks.every((c) => c.pass);
  return { id: testCase.id, tag: testCase.tag, passed, checks, tokensIn, tokensOut, latencyMs: Date.now() - startedAt };
}

async function main() {
  // Test DB: migrate, wipe, seed the question bank.
  const url = process.env.TEST_DATABASE_URL!;
  const admin = postgres(url, { max: 1 });
  await migrate(drizzle(admin), { migrationsFolder: "./drizzle" });
  await admin.end();
  await db.execute("TRUNCATE agent_steps, interviews, turns, sessions, users, questions CASCADE" as never);
  await db.insert(questions).values(QUESTION_BANK).onConflictDoNothing();

  const [user] = await db
    .insert(users)
    .values({ email: "eval@vox.local", name: "Vox Eval" })
    .onConflictDoUpdate({ target: users.email, set: { email: "eval@vox.local" } })
    .returning();
  if (!user) throw new Error("could not create eval user");

  console.log(`Running ${CASES.length} eval cases (concurrency ${CONCURRENCY}, threshold ${PASS_THRESHOLD})...\n`);
  const results: CaseResult[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < CASES.length) {
      const c = CASES[cursor++];
      process.stdout.write(`  ${c.id} (${c.tag}) ... `);
      const r = await runCase(c, user!.id);
      results.push(r);
      console.log(r.passed ? "PASS" : `FAIL (${r.checks.filter((x) => !x.pass).map((x) => x.name).join(", ")})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Per-tag report.
  const tags = ["weak", "average", "strong"] as const;
  let tokensIn = 0, tokensOut = 0, latency = 0;
  console.log("\nPer-tag pass rates:");
  for (const tag of tags) {
    const rs = results.filter((r) => r.tag === tag);
    const rate = rs.length ? rs.filter((r) => r.passed).length / rs.length : 0;
    console.log(`  ${tag.padEnd(8)} ${(rate * 100).toFixed(0)}%  (${rs.filter((r) => r.passed).length}/${rs.length})`);
  }
  for (const r of results) { tokensIn += r.tokensIn; tokensOut += r.tokensOut; latency += r.latencyMs; }
  const passRate = results.filter((r) => r.passed).length / results.length;
  console.log(`\nOverall pass rate: ${(passRate * 100).toFixed(0)}% (threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%)`);
  console.log(`Tokens: ${tokensIn} in / ${tokensOut} out — est. cost $${estimateCost(tokensIn, tokensOut).toFixed(4)}`);
  console.log(`Avg latency per case: ${Math.round(latency / results.length)}ms`);

  const failed = results.filter((r) => !r.passed);
  for (const f of failed) {
    console.log(`\n${f.id} [${f.tag}] failed checks:`);
    for (const c of f.checks.filter((x) => !x.pass)) console.log(`  - ${c.name}: ${c.detail}`);
  }

  await db.execute("TRUNCATE agent_steps, interviews, turns, sessions, users, questions CASCADE" as never);
  if (passRate < PASS_THRESHOLD) {
    console.error(`\nEval FAILED: pass rate ${(passRate * 100).toFixed(0)}% < ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
