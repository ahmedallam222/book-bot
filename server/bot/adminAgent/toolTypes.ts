// Shared tool types for admin agent (split from tools.ts)

export interface ToolRunCtx {
  userId: string;
  /** Optional role for permission checks (v4+) */
  role?: "owner" | "operator" | "viewer";
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isWrite: boolean;
  run(args: Record<string, unknown>, ctx: ToolRunCtx): Promise<unknown>;
}
