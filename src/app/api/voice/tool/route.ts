// Executes one agent tool call on behalf of a live voice session (Phase 6).
// The live model emits toolCall frames in the browser; the browser forwards
// them here so the same zod-validated handlers and agent-step tracing as the
// text agent loop apply, then relays the JSON result back into the session
// as a toolResponse frame.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { checkRate, originAllowed, blockedOrigin } from "@/lib/rate-limit";
import { upsertUserByEmail } from "@/lib/db";
import { getTool, type ToolContext } from "@/agent/tools";
import { addAgentStep } from "@/lib/db/repository";
import { setSentryUser, captureVoxError } from "@/lib/observability";
import { startToolSpan } from "@/lib/tracing";
import "@/agent/tools/all";

export const runtime = "nodejs";

const bodySchema = z.object({
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.any()).default({}),
  interviewId: z.string().uuid().nullable().default(null),
});

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return blockedOrigin();
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = await checkRate(req, "chat", session.user.email);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid tool call" }, { status: 400 });
  const { name, args, interviewId } = parsed.data;

  const user = await upsertUserByEmail(session.user.email);
  const ctx: ToolContext = { userId: user?.id ?? null, interviewId };
  setSentryUser(user?.id);

  const tool = getTool(name);
  if (!tool) {
    return NextResponse.json({ ok: false, error: `Unknown tool: ${name}` });
  }

  // Same guardrail as the text loop: validate arguments with the tool's own
  // zod schema before the handler sees them.
  const valid = tool.inputSchema.safeParse(args);
  if (!valid.success) {
    return NextResponse.json({
      ok: false,
      error: `Invalid arguments for ${name}: ${valid.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    });
  }

  const startedAt = Date.now();
  const span = startToolSpan({ userId: user?.id ?? "", interviewId: interviewId ?? "", name });
  try {
    const output = await tool.handler(valid.data, ctx);
    span?.end({ ok: true });
    if (interviewId && ctx.userId) {
      try {
        await addAgentStep({
          interviewId,
          stepIndex: -1, // live-session steps are ordered by createdAt
          toolName: name,
          input: args ?? {},
          output: output ?? {},
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        console.error("live agent step trace failed", err);
      }
    }
    return NextResponse.json({ ok: true, result: output ?? { ok: true } });
  } catch (e: any) {
    span?.end({ ok: false, error: e?.message ?? "tool failed" });
    const message = e?.message ?? "tool failed";
    console.error("live tool call failed:", name, message);
    captureVoxError(e, { route: "/api/voice/tool", tool: name });
    return NextResponse.json({ ok: false, error: message });
  }
}
