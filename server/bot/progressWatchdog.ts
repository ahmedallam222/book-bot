// ══════════════════════════════════════════════════════════════════
// PROGRESS WATCHDOG — fires reassurance messages on long-stalled
// progress edits. Each `armProgressWatchdog` call replaces any
// previous timers for that msgId. Two timers per msgId:
//   • t15: 15 seconds → soft reassurance line
//   • t30: 30 seconds → deeper reassurance line
//
// All reassurance text is formal Modern Standard Arabic (الفصحى)
// per the user's explicit request. Pulled from `uiVariants.ts`.
//
// Telegram editMessageText is rate-limited to ~1/sec/chat; the
// watchdog edits at ≥ 15 second intervals so it never collides
// with the natural step transitions in `bookRequest.ts`.
// ══════════════════════════════════════════════════════════════════

import { editMsg } from "./ui.js";
import { buildProgress } from "./ui.js";
import {
  WAIT_REASSURANCE_15S,
  WAIT_REASSURANCE_30S,
  pickRandom,
} from "./uiVariants.js";

interface WatchdogState {
  t15: NodeJS.Timeout;
  t30: NodeJS.Timeout;
}

const watchdogs = new Map<number, WatchdogState>();

/**
 * Arms (or re-arms) the reassurance watchdog for a given progress
 * message. Call this every time the visible step transitions —
 * the previous timers are cleared so reassurance only fires when
 * progress has actually stalled.
 */
export function armProgressWatchdog(
  token:    string,
  chatId:   number,
  msgId:    number,
  step:     number,
  bookName: string,
): void {
  if (!msgId) return;
  clearProgressWatchdog(msgId);

  const t15 = setTimeout(() => {
    const reassurance = pickRandom(WAIT_REASSURANCE_15S);
    editMsg(token, chatId, msgId, buildProgress(step, bookName, reassurance))
      .catch(() => {});
  }, 15_000);

  const t30 = setTimeout(() => {
    const reassurance = pickRandom(WAIT_REASSURANCE_30S);
    editMsg(token, chatId, msgId, buildProgress(step, bookName, reassurance))
      .catch(() => {});
  }, 30_000);

  // Don't keep the Node.js event loop alive on these timers — the
  // process must be free to shut down on SIGTERM.
  t15.unref?.();
  t30.unref?.();

  watchdogs.set(msgId, { t15, t30 });
}

/** Clears both reassurance timers for a msgId. Idempotent. */
export function clearProgressWatchdog(msgId: number): void {
  const state = watchdogs.get(msgId);
  if (!state) return;
  clearTimeout(state.t15);
  clearTimeout(state.t30);
  watchdogs.delete(msgId);
}

/**
 * Number of tracked watchdogs. For tests / observability only.
 */
export function _watchdogCount(): number {
  return watchdogs.size;
}
