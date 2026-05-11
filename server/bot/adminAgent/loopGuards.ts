// ══════════════════════════════════════════════════════════
// Admin Agent — Loop hardening guards
// ══════════════════════════════════════════════════════════
// Three lightweight in-memory guards that run inside the tool-call
// loop in `startAdminAgent`:
//
//   1. **Duplicate-call detector**: tracks `(toolName, JSON.stringify(args))`
//      per *user turn*. When the same signature is requested ≥
//      DUPLICATE_THRESHOLD times in a row by the model, we refuse the
//      execution and synthesise a tool result that tells the model
//      "you already called this — use the previous result". This
//      catches the most common pathology (model gets stuck looping
//      on the same tool) at iteration 3 instead of letting it burn
//      the whole loop budget.
//
//   2. **Per-call rate cap**: even non-consecutive duplicate calls
//      have a hard cap (DUPLICATE_HARD_CAP) per turn. Stops the model
//      from interleaving 2-3 tools and looping anyway.
//
//   3. **Token-budget guard**: rough character/4 estimate of total
//      conversation size. When it exceeds TOKEN_BUDGET_CHARS we
//      signal the outer loop to break and force a final answer —
//      preventing context-window explosions when many heavy tools
//      run in one turn.
//
// All state is per-turn (one BurstGuard instance is created per
// admin message); nothing persists between turns. Zero Redis calls.

import type { LLMMessage } from "./llm.js";

/** Default threshold for "consecutive same call" detection.
 * After 3 identical (toolName, args) requests, we synthesise a
 * refusal. The first 2 still get executed. */
export const DUPLICATE_THRESHOLD = 3;

/** Default hard cap for *total* repeats per signature, even if
 * interleaved with other tools. */
export const DUPLICATE_HARD_CAP = 6;

/** Rough total-conversation char limit before we abort the loop and
 * force a final answer. ~50k tokens at 4 chars/token = 200k chars.
 * Llama 3.3 has a 128k context window but we leave headroom for
 * the final completion + tool definitions. */
export const TOKEN_BUDGET_CHARS = 200_000;

/** When the burst guard has refused this many tool calls in a single
 * turn, the model is clearly ignoring the refusal messages and
 * retrying anyway. Bail out of the loop and go straight to the
 * forced-final-answer path. Without this, prod observed cases where
 * the model burned all 24 iterations on refused-then-retried calls
 * to the same wrong tool. */
export const MAX_REFUSALS_BEFORE_BAIL = 4;

/** Build a stable signature for a tool call. Sorts JSON keys so
 * `{a:1,b:2}` and `{b:2,a:1}` hash to the same string. */
export function callSignature(toolName: string, args: Record<string, unknown>): string {
  let argsStr: string;
  try {
    const keys = Object.keys(args).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = args[k];
    argsStr = JSON.stringify(ordered);
  } catch {
    argsStr = String(args);
  }
  return `${toolName}::${argsStr}`;
}

export interface BurstGuardState {
  /** Total invocations seen per signature this turn (incl. refused). */
  total: Map<string, number>;
  /** Last signature actually executed (consecutive run tracker). */
  lastSig: string | null;
  /** Consecutive count of `lastSig`. */
  consecutive: number;
  /** Aggregate count of how many tool calls were refused this turn. */
  refusedCount: number;
}

export function createBurstGuard(): BurstGuardState {
  return {
    total:        new Map<string, number>(),
    lastSig:      null,
    consecutive:  0,
    refusedCount: 0,
  };
}

/** Decision for an incoming tool call. */
export type BurstDecision =
  | { allow: true }
  | { allow: false; reason: "consecutive_duplicate" | "hard_cap"; count: number };

/** Inspect a new tool call against the burst guard state.
 *
 * If the call passes, the caller MUST invoke `recordExecution(state, sig)`
 * after the tool runs. If the call is refused, the caller MUST invoke
 * `recordRefusal(state, sig)` and synthesise a refusal tool message back
 * to the LLM (use {@link refusalToolContent}). */
export function inspectCall(state: BurstGuardState, sig: string): BurstDecision {
  const prevTotal = state.total.get(sig) ?? 0;

  // Hard cap: too many of this exact call this turn, regardless of order.
  if (prevTotal >= DUPLICATE_HARD_CAP) {
    return { allow: false, reason: "hard_cap", count: prevTotal };
  }

  // Consecutive duplicate: if the model just made this exact call
  // DUPLICATE_THRESHOLD-1 times in a row, refuse the next one.
  if (state.lastSig === sig && state.consecutive >= DUPLICATE_THRESHOLD - 1) {
    return { allow: false, reason: "consecutive_duplicate", count: state.consecutive };
  }

  return { allow: true };
}

/** Record that we actually executed a tool with this signature. */
export function recordExecution(state: BurstGuardState, sig: string): void {
  state.total.set(sig, (state.total.get(sig) ?? 0) + 1);
  if (state.lastSig === sig) state.consecutive++;
  else { state.lastSig = sig; state.consecutive = 1; }
}

/** Record that we refused to execute a tool with this signature. */
export function recordRefusal(state: BurstGuardState, sig: string): void {
  state.total.set(sig, (state.total.get(sig) ?? 0) + 1);
  state.refusedCount++;
  // Refused calls still break the consecutive streak — we want the
  // model to *change* its approach, not just keep getting refused.
  state.lastSig = null;
  state.consecutive = 0;
}

/** Build a synthetic tool-result payload telling the model that it
 * just repeated itself and needs to change approach. The payload is
 * intentionally JSON so it parses cleanly on the model side. */
export function refusalToolContent(
  toolName: string,
  decision: Extract<BurstDecision, { allow: false }>,
): string {
  const ar =
    decision.reason === "consecutive_duplicate"
      ? `لقد استدعيت الأداة \`${toolName}\` ${DUPLICATE_THRESHOLD} مرات متتالية بنفس المعطيات. ` +
        "استخدم النتيجة السابقة من قائمة الرسائل أعلاه، أو غيّر المعطيات، أو أجِب المستخدم بناءً على ما لديك."
      : `لقد استدعيت الأداة \`${toolName}\` ${decision.count} مرات بنفس المعطيات هذه الجلسة. ` +
        "هذا هو الحد الأقصى. أجِب المستخدم بناءً على النتائج السابقة أو غيّر الأداة.";
  return JSON.stringify({
    error:      "duplicate_tool_call_refused",
    reason:     decision.reason,
    count:      decision.count,
    instruction_ar: ar,
    instruction_en:
      decision.reason === "consecutive_duplicate"
        ? `You called ${toolName} with the same arguments ${DUPLICATE_THRESHOLD} times in a row. Use the previous result, change the arguments, or answer the user from what you have.`
        : `You have called ${toolName} ${decision.count} times this turn with the same arguments. This is the cap. Answer from the existing results or pick a different tool.`,
  });
}

// ── Token-budget guard ───────────────────────────────────────────

/** Cheap, approximation-only "token" count: total chars across the
 * messages array, since estimating real tokenizer output would
 * require shipping the model's tokenizer. 4 chars/token is the
 * widely-used rule-of-thumb for English; Arabic averages ~3 chars/
 * token (richer characters per byte), so this estimate is slightly
 * conservative for our use-case which is exactly what we want for a
 * safety cap. */
export function estimateConversationChars(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += m.content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += tc.function.name.length + tc.function.arguments.length + 32;
      }
    }
  }
  return total;
}

/** True if the conversation has grown past the safe budget and we
 * should bail out of the tool loop and force a final answer. */
export function isOverTokenBudget(messages: LLMMessage[]): boolean {
  return estimateConversationChars(messages) > TOKEN_BUDGET_CHARS;
}
