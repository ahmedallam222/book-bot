// ══════════════════════════════════════════════════════════════════
// FAILURE RETRY — auto-retry-on-improvement
// ══════════════════════════════════════════════════════════════════
//
// Problem: a user searches for a book, the bot fails to deliver
// (no_results / fail_after_attempts / error). Later, the search
// machinery improves: a fix lands (e.g. PR #97 rescue-low-relevance),
// a source becomes reachable again, a PDF gets indexed, or the cache
// gets warmed by another user. The original requester has moved on
// and never gets the book.
//
// This module records every failure with a short TTL, then a
// background worker sweeps the pending records on a schedule and
// retries each search with the current code. On success it sends the
// PDF as a reply-quote to the user's original message, prefaced by a
// brief apology, and removes the record.
//
// Storage: one Redis key per failure
//   retry:fail:{userId}:{chatId}:{bookHash}
//   value = JSON FailedSearch
//   TTL   = RETRY_TTL_DAYS days
//
// We dedupe on (userId, chatId, canonicalized bookName) so repeated
// failures of the same query just bump `attempts`/`lastTs` instead of
// piling up. After RETRY_MAX_ATTEMPTS attempts we delete the record
// so we don't keep retrying a permanently-unavailable book.
//
// Trigger:
//   - background interval (every RETRY_WORKER_INTERVAL_MS)
//   - admin command /retry_failures (manual fan-out)
//
// We deliberately keep the retry pipeline thinner than
// performFullSearch (no progress UI, no fuzzy fallback): if the
// search now finds something, deliver it; otherwise leave the record
// for next pass. We share the same rescue-low-relevance threshold as
// bookRequest.ts so retries see exactly the same candidate set as a
// fresh search would.

import TelegramBot from "node-telegram-bot-api";
import crypto from "node:crypto";
import { L } from "./logger.js";
import { redis } from "./redis.js";
import { canonicalizeForCache, escMd, urlFilenameRelevance } from "./text.js";
import { searchAllSources } from "./engine.js";
import { findValidPdfUrls } from "./verify.js";
import { downloadAndSend } from "./download.js";
import { isBanned } from "./guards.js";
import { ADMIN_IDS } from "./config.js";
import type { BookResult } from "./types.js";

// ── Tunables ───────────────────────────────────────────────────────
const KEY_PREFIX                = "retry:fail";
const RETRY_TTL_DAYS            = 7;
const RETRY_MAX_ATTEMPTS        = 3;
const RETRY_MIN_COOLDOWN_MS     = 30 * 60 * 1000;        // 30 min between attempts on the same record
const RETRY_WORKER_INTERVAL_MS  = 30 * 60 * 1000;        // sweeper period
const RETRY_WORKER_STARTUP_MS   = 5 * 60 * 1000;         // startup delay (let DB/redis stabilize)
const RETRY_BATCH_LIMIT         = 25;                    // max records per pass
const RETRY_RESCUE_BEST_PDF_THRESHOLD = 0.30;            // mirrors bookRequest.ts
const RETRY_RESCUE_FALLBACK_THRESHOLD = 0.50;            // mirrors bookRequest.ts
const RETRY_RESCUE_MAX_FALLBACKS      = 3;               // mirrors bookRequest.ts

// Lock key — only one retry worker pass at a time across the whole
// fleet (we run a single bot instance, but this guards against the
// admin command and the scheduled sweep colliding).
const PASS_LOCK_KEY     = "retry:fail:lock";
const PASS_LOCK_TTL_SEC = 10 * 60;

// ── Types ──────────────────────────────────────────────────────────

export interface FailedSearch {
  /** Telegram user_id (string per the bot's own typing). */
  userId:        string;
  /** Telegram numeric chat_id (same as userId for DMs, negative for groups). */
  chatId:        number;
  /** message_id of the user's original request — used for reply-quote. */
  userMessageId: number;
  /** Optional Telegram @username (no leading @) — used in apology copy. */
  userName:      string | null;
  /** The book name as the user typed it. */
  bookName:      string;
  /** Failure category — narrows the apology copy. */
  reason:        "no_results" | "all_attempts_failed" | "error";
  /** Unix ms when this record was first created. */
  firstTs:       number;
  /** Unix ms of the most recent retry attempt. */
  lastTs:        number;
  /** Retry count (0 on first record, bumped each pass). */
  attempts:      number;
}

export interface RetryPassResult {
  scanned:   number;
  attempted: number;
  delivered: number;
  expired:   number;
  cooldown:  number;
  errors:    number;
}

// ── Key helpers ────────────────────────────────────────────────────

function bookHash(bookName: string): string {
  return crypto
    .createHash("sha1")
    .update(canonicalizeForCache(bookName))
    .digest("hex")
    .slice(0, 12);
}

export function failureKey(userId: string, chatId: number, bookName: string): string {
  return `${KEY_PREFIX}:${userId}:${chatId}:${bookHash(bookName)}`;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record a failed search. Idempotent on (userId, chatId, bookName) —
 * repeat calls bump `attempts`/`lastTs` and refresh the TTL.
 *
 * Skipped silently if the user has no userMessageId (we can't reply
 * to them later). Also skipped for ADMIN_IDS — admins running probes
 * don't need apologies.
 */
export async function recordFailure(rec: Omit<FailedSearch, "firstTs" | "lastTs" | "attempts"> & {
  attempts?: number;
}): Promise<void> {
  if (!rec.userMessageId) return;
  if (ADMIN_IDS.has(rec.userId)) return;

  const key = failureKey(rec.userId, rec.chatId, rec.bookName);
  const now = Date.now();

  try {
    const existing = await redis.get(key);
    if (existing) {
      const prev = JSON.parse(existing) as FailedSearch;
      const merged: FailedSearch = {
        ...prev,
        userMessageId: rec.userMessageId,  // newer message id (user retried with new message)
        userName:      rec.userName ?? prev.userName,
        reason:        rec.reason,
        lastTs:        now,
        attempts:      (rec.attempts ?? prev.attempts) || prev.attempts,
      };
      await redis.set(key, JSON.stringify(merged), "EX", RETRY_TTL_DAYS * 86400);
      return;
    }

    const fresh: FailedSearch = {
      userId:        rec.userId,
      chatId:        rec.chatId,
      userMessageId: rec.userMessageId,
      userName:      rec.userName ?? null,
      bookName:      rec.bookName,
      reason:        rec.reason,
      firstTs:       now,
      lastTs:        now,
      attempts:      0,
    };
    await redis.set(key, JSON.stringify(fresh), "EX", RETRY_TTL_DAYS * 86400);
    L.info("retry", "Failure recorded for later replay", {
      userId:   rec.userId,
      book:     rec.bookName.slice(0, 50),
      reason:   rec.reason,
    });
  } catch (e) {
    L.warn("retry", "recordFailure error (non-fatal)", { err: String(e).slice(0, 100) });
  }
}

/** Delete a stored failure record (e.g. after successful retry). */
export async function removeFailure(key: string): Promise<void> {
  await redis.del(key).catch(() => {});
}

/**
 * Scan up to `limit` pending failure records, oldest-first by
 * lastTs (so heavy-traffic users don't starve out older entries).
 * Returns deserialized records along with their Redis keys.
 */
export async function listPendingFailures(
  limit = RETRY_BATCH_LIMIT,
): Promise<Array<{ key: string; rec: FailedSearch }>> {
  const out: Array<{ key: string; rec: FailedSearch }> = [];
  let cursor = "0";
  // We scan until we either exhaust the keyspace or we've collected
  // at least 4× the limit, then sort and trim. This is a tradeoff:
  // SCAN doesn't guarantee ordering, but on a small keyspace (we cap
  // at TTL_DAYS × per-day failures) the cost is bounded.
  const collected: Array<{ key: string; rec: FailedSearch }> = [];
  const HARD_CAP = limit * 4;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${KEY_PREFIX}:*`, "COUNT", 200);
    cursor = nextCursor;
    if (keys.length > 0) {
      const vals = await redis.mget(...keys);
      for (let i = 0; i < keys.length; i++) {
        const v = vals[i];
        if (!v) continue;
        try {
          collected.push({ key: keys[i], rec: JSON.parse(v) as FailedSearch });
        } catch {
          // corrupt entry — drop it
          await redis.del(keys[i]).catch(() => {});
        }
      }
    }
    if (collected.length >= HARD_CAP) break;
  } while (cursor !== "0");

  // Oldest-first by lastTs gives stable progress when many entries pile up
  collected.sort((a, b) => a.rec.lastTs - b.rec.lastTs);
  out.push(...collected.slice(0, limit));
  return out;
}

// ── Retry pipeline ────────────────────────────────────────────────

/**
 * Try to recover a single failed search. Returns true if delivery
 * succeeded (and the record was removed). Returns false on any
 * outcome that should leave the record for a future pass.
 */
async function retryOne(
  bot:    TelegramBot,
  token:  string,
  key:    string,
  rec:    FailedSearch,
): Promise<{ outcome: "delivered" | "still_no_pdf" | "expired" | "cooldown" | "blocked" | "error" }> {
  // Cooldown — don't hammer the same record too often. The first
  // attempt fires immediately (lastTs === firstTs), subsequent
  // attempts wait at least RETRY_MIN_COOLDOWN_MS.
  if (rec.attempts > 0 && Date.now() - rec.lastTs < RETRY_MIN_COOLDOWN_MS) {
    return { outcome: "cooldown" };
  }

  // Skip banned users so we don't try to send them a PDF they
  // explicitly opted out of receiving (or got banned for abuse).
  if (await isBanned(rec.userId).catch(() => false)) {
    await removeFailure(key);
    return { outcome: "blocked" };
  }

  if (rec.attempts >= RETRY_MAX_ATTEMPTS) {
    await removeFailure(key);
    return { outcome: "expired" };
  }

  // Bump the attempt counter and lastTs *before* the search so a
  // crash doesn't leave the record in a state where the cooldown
  // never elapses.
  const updated: FailedSearch = {
    ...rec,
    attempts: rec.attempts + 1,
    lastTs:   Date.now(),
  };
  await redis.set(key, JSON.stringify(updated), "EX", RETRY_TTL_DAYS * 86400).catch(() => {});

  // ── Run the search ─────────────────────────────────────────────
  let results: BookResult[];
  try {
    results = await searchAllSources(rec.bookName);
  } catch (e) {
    L.warn("retry", "searchAllSources threw", { book: rec.bookName.slice(0, 40), err: String(e).slice(0, 100) });
    return { outcome: "error" };
  }
  if (!results || results.length === 0) {
    return { outcome: "still_no_pdf" };
  }

  // Gather candidates — same triage as bookRequest.ts but without
  // the verbose UI scaffolding.
  const allPdfUrls: string[] = [];
  const downloadablePageFallbacks: string[] = [];
  const urlSearchTitle = new Map<string, string>();
  const seenPdf = new Set<string>();
  const seenPage = new Set<string>();

  for (const r of results) {
    const cleanTitle = r.title && !r.title.startsWith("http") ? r.title : "";
    if (r.directPdfUrl) {
      if (!seenPdf.has(r.directPdfUrl)) {
        seenPdf.add(r.directPdfUrl);
        allPdfUrls.push(r.directPdfUrl);
      }
      if (cleanTitle && !urlSearchTitle.has(r.directPdfUrl)) {
        urlSearchTitle.set(r.directPdfUrl, cleanTitle);
      }
    } else if (r.url && r.access === "download_page") {
      if (!seenPage.has(r.url)) {
        seenPage.add(r.url);
        downloadablePageFallbacks.push(r.url);
      }
      if (cleanTitle && !urlSearchTitle.has(r.url)) {
        urlSearchTitle.set(r.url, cleanTitle);
      }
    }
  }

  const verify = await findValidPdfUrls(allPdfUrls).catch(() => null);
  let validUrls: string[] = verify?.urls ?? [];

  // Fallbacks: replicate the same chain bookRequest.ts uses so retries
  // see the same candidate set as a fresh search.
  if (validUrls.length === 0 && allPdfUrls.length > 0) {
    validUrls = allPdfUrls.slice(0, 5);
  } else if (validUrls.length === 0 && downloadablePageFallbacks.length > 0) {
    validUrls = downloadablePageFallbacks.slice(0, 3);
  }

  // Mirror the rescue-low-relevance augmentation from PR #97 so
  // retries pick up the same fix that motivated this whole feature.
  if (validUrls.length > 0 && downloadablePageFallbacks.length > 0) {
    const score = (u: string): number => {
      const a = urlFilenameRelevance(rec.bookName, u);
      const t = urlSearchTitle.get(u);
      if (!t) return a;
      const titleAsUrl = `https://x/${encodeURIComponent(t)}.pdf`;
      return Math.max(a, urlFilenameRelevance(rec.bookName, titleAsUrl));
    };
    const bestPdfScore = score(validUrls[0]);
    if (bestPdfScore < RETRY_RESCUE_BEST_PDF_THRESHOLD) {
      const augmented = [...new Set(downloadablePageFallbacks)]
        .filter((u) => !validUrls.includes(u))
        .map((u) => ({ url: u, s: score(u) }))
        .filter(({ s }) => s >= RETRY_RESCUE_FALLBACK_THRESHOLD)
        .sort((a, b) => b.s - a.s)
        .slice(0, RETRY_RESCUE_MAX_FALLBACKS)
        .map((x) => x.url);
      validUrls.push(...augmented);
    }
  }

  if (validUrls.length === 0) {
    return { outcome: "still_no_pdf" };
  }

  // ── Send apology preface (reply-quoted to original message) ──
  // We send this *before* the PDF so the user sees context first.
  // Fall back gracefully if the original message was deleted —
  // allow_sending_without_reply lets Telegram drop the quote rather
  // than rejecting the whole message.
  //
  // bookName + userName are user-controlled and may contain Markdown
  // metacharacters (`_`, `*`, `[`, `]`, ` `` `). Escaping them defends
  // against `can't parse entities` rejections from Telegram. Telegram
  // usernames officially allow only alphanumerics + `_`, so the
  // underscore is the realistic clash with our `_..._` italic wrapper.
  const safeBook = escMd(rec.bookName.slice(0, 60));
  const displayName = rec.userName ? `@${escMd(rec.userName)}` : "🙏";
  const apology =
    `🙏 *أعتذر على التأخير* — وجدتُ كتاب "${safeBook}" الآن\n` +
    `_${displayName}، كنتَ قد طلبته من قبل ولم يكن متاحاً حينها_`;

  await bot.sendMessage(rec.chatId, apology, {
    parse_mode:                  "Markdown",
    reply_to_message_id:         rec.userMessageId,
    allow_sending_without_reply: true,
    disable_web_page_preview:    true,
  }).catch((e) => {
    L.warn("retry", "apology send failed (non-fatal)", { err: String(e).slice(0, 100) });
  });

  // ── Try each candidate until one delivers ──────────────────────
  for (const url of validUrls.slice(0, 3)) {
    const title = urlSearchTitle.get(url) ?? "";
    let dl;
    try {
      dl = await downloadAndSend(bot, rec.chatId, url, rec.bookName, token, false, false, title);
    } catch (e) {
      L.warn("retry", "downloadAndSend threw", { url: url.slice(0, 60), err: String(e).slice(0, 100) });
      continue;
    }
    if (dl?.ok) {
      L.info("retry", "Delivered after retry", {
        userId:   rec.userId,
        book:     rec.bookName.slice(0, 50),
        attempts: updated.attempts,
        ageHours: ((Date.now() - rec.firstTs) / 3_600_000).toFixed(1),
        url:      url.slice(0, 80),
      });
      await removeFailure(key);
      await redis.incr("tel:retry:delivered").catch(() => {});
      return { outcome: "delivered" };
    }
  }

  return { outcome: "still_no_pdf" };
}

/**
 * Sweep all pending failure records and retry them. Returns
 * aggregate counters. Holds a single Redis lock so only one pass
 * runs at a time across scheduler + admin command.
 */
export async function runRetryPass(
  bot:   TelegramBot,
  token: string,
  opts:  { limit?: number; triggeredBy?: "scheduler" | "admin" } = {},
): Promise<RetryPassResult> {
  const lock = await redis.set(PASS_LOCK_KEY, String(Date.now()), "EX", PASS_LOCK_TTL_SEC, "NX").catch(() => null);
  if (lock !== "OK") {
    L.info("retry", "Skipping pass — another worker holds the lock");
    return { scanned: 0, attempted: 0, delivered: 0, expired: 0, cooldown: 0, errors: 0 };
  }

  const result: RetryPassResult = { scanned: 0, attempted: 0, delivered: 0, expired: 0, cooldown: 0, errors: 0 };
  try {
    const pending = await listPendingFailures(opts.limit ?? RETRY_BATCH_LIMIT);
    result.scanned = pending.length;

    for (const { key, rec } of pending) {
      try {
        const { outcome } = await retryOne(bot, token, key, rec);
        if (outcome === "cooldown")  result.cooldown++;
        else if (outcome === "delivered") { result.delivered++; result.attempted++; }
        else if (outcome === "expired" || outcome === "blocked") result.expired++;
        else if (outcome === "still_no_pdf") result.attempted++;
        else if (outcome === "error") result.errors++;
      } catch (e) {
        result.errors++;
        L.warn("retry", "retryOne threw", { err: String(e).slice(0, 100) });
      }
    }

    if (result.scanned > 0 || opts.triggeredBy === "admin") {
      L.info("retry", `Retry pass complete (${opts.triggeredBy ?? "scheduler"})`, { ...result });
    }
  } finally {
    await redis.del(PASS_LOCK_KEY).catch(() => {});
  }

  return result;
}

/**
 * Start the background sweeper. Call once at bot startup, after
 * Redis/DB are healthy. Mirrors the alertWatcher pattern so its
 * timers can be `unref`'d and won't keep the process alive.
 */
export function startFailureRetryWorker(bot: TelegramBot, token: string): void {
  setTimeout(() => {
    runRetryPass(bot, token).catch((e) =>
      L.warn("retry", "First retry pass error", { err: String(e).slice(0, 100) }),
    );
    setInterval(() => {
      runRetryPass(bot, token).catch((e) =>
        L.warn("retry", "Retry pass error", { err: String(e).slice(0, 100) }),
      );
    }, RETRY_WORKER_INTERVAL_MS).unref();
  }, RETRY_WORKER_STARTUP_MS).unref();

  L.info("retry", `Failure retry worker started — interval=${RETRY_WORKER_INTERVAL_MS / 60_000}min ttl=${RETRY_TTL_DAYS}d max_attempts=${RETRY_MAX_ATTEMPTS}`);
}
