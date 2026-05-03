import { randomBytes } from "crypto";

// ══════════════════════════════════════════════
// SESSION — جلسات مؤقتة للـ callbacks
// ══════════════════════════════════════════════
//
// Telegram callback_data محدود بـ 64 بايت — لا يكفي لتخزين URL + bookName
// نحتفظ بالبيانات في الذاكرة ونبعت مفتاحاً قصيراً في الـ callback_data

interface SessionEntry {
  bookName?: string;
  url?:      string;
  ts:        number;
}

const _sessions = new Map<string, SessionEntry>();
const SESSION_TTL_MS  = 24 * 3_600_000; // 24h
const SESSION_MAX     = 5_000;

// تنظيف دوري
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sessions) {
    if (now - v.ts > SESSION_TTL_MS) _sessions.delete(k);
  }
}, 30 * 60_000).unref();

function newKey(): string {
  return randomBytes(6).toString("hex");
}

function enforceLimit(): void {
  if (_sessions.size < SESSION_MAX) return;
  // احذف أقدم 500 entry
  const oldest = [..._sessions.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)
    .slice(0, 500)
    .map(([k]) => k);
  for (const k of oldest) _sessions.delete(k);
}

export function getSession(key: string): SessionEntry | undefined {
  return _sessions.get(key);
}

export function deleteSession(key: string): void {
  _sessions.delete(key);
}

export function storeRetryKey(bookName: string): string {
  enforceLimit();
  const key = newKey();
  _sessions.set(key, { bookName, ts: Date.now() });
  return key;
}

export function storeFeedbackUrl(url: string, bookName: string): string {
  enforceLimit();
  const key = newKey();
  _sessions.set(key, { url, bookName, ts: Date.now() });
  return key;
}

// Stores both bookName and the source URL the file was delivered from,
// so the summary callback can re-download the PDF for AI analysis.
// `url` is optional — for cache-served deliveries we may not have a
// fresh sourceUrl, in which case the summary path falls back to text-
// only providers using Wikipedia context.
export function storeSummaryKey(bookName: string, url?: string): string {
  enforceLimit();
  const key = newKey();
  _sessions.set(key, { bookName, url, ts: Date.now() });
  return key;
}
