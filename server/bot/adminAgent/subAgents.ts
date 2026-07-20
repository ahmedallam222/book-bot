// ══════════════════════════════════════════════
// SUB-AGENTS (lite) — parallel playbook runners
//
// Not full multi-process agents: concurrent tool
// pipelines that fan-out and merge results for the
// parent admin-agent turn (Hermes-style fan-out).
// ══════════════════════════════════════════════

import type { Tool, ToolRunCtx } from "./toolTypes.js";

type PlaybookName =
  | "health_full"
  | "slow_delivery"
  | "source_outage"
  | "daily_brief"
  | "retention_pulse"
  | "library_taste";

/**
 * Builds a tool that runs 2–3 playbooks in parallel via the existing
 * run_playbook implementation (injected to avoid circular imports).
 */
export function createParallelBriefsTool(
  runPlaybook: (args: Record<string, unknown>, ctx: ToolRunCtx) => Promise<unknown>,
): Tool {
  return {
    name: "run_subagents",
    description:
      "شغّل 2–3 playbooks بالتوازي (sub-agents خفيفة) واجمع النتائج. " +
      "مثال: [\"daily_brief\",\"source_outage\"] أو [\"slow_delivery\",\"retention_pulse\"].",
    parameters: {
      type: "object",
      properties: {
        playbooks: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "health_full",
              "slow_delivery",
              "source_outage",
              "daily_brief",
              "retention_pulse",
              "library_taste",
            ],
          },
          description: "2 أو 3 playbooks كحد أقصى",
        },
      },
      required: ["playbooks"],
    },
    isWrite: false,
    async run(args, ctx) {
      const list = Array.isArray(args.playbooks) ? args.playbooks.map(String) : [];
      const unique = [...new Set(list)].slice(0, 3) as PlaybookName[];
      if (unique.length < 1) throw new Error("playbooks required (1–3)");
      const t0 = Date.now();
      const settled = await Promise.all(
        unique.map(async (name) => {
          const s0 = Date.now();
          try {
            const result = await runPlaybook({ name }, ctx);
            return { playbook: name, ok: true as const, ms: Date.now() - s0, result };
          } catch (e) {
            return {
              playbook: name,
              ok: false as const,
              ms: Date.now() - s0,
              error: String(e instanceof Error ? e.message : e).slice(0, 200),
            };
          }
        }),
      );
      return {
        parallel: true,
        total_ms: Date.now() - t0,
        agents: settled,
        merge_hint_ar:
          "ادمج النتائج في ملخص واحد: حالة عامة → مشاكل → إجراءات مقترحة.",
      };
    },
  };
}
