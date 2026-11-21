import { z } from "zod";

// A tool is a named, described, zod-validated function the agent's model may
// call. Handlers receive parsed input plus the current run context and return
// any JSON-serializable value.
export type ToolContext = {
  userId: string | null;
  interviewId: string | null;
};

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown> | unknown;
}

const registry = new Map<string, AgentTool>();

export function registerTool(tool: AgentTool) {
  registry.set(tool.name, tool);
}

export function getTool(name: string) {
  return registry.get(name) ?? null;
}

export function toolRegistry(): AgentTool[] {
  return Array.from(registry.values());
}
