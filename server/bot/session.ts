import { RETRY_KEY_TTL } from "./config.js";
import type { SessionEntry } from "./types.js";
import { normalizeForCache } from "./text.js";

// ══════════════════════════════════════════════
// SESSION STORE
// حل مشكلة callback_data > 64 bytes (Telegram limit):
// نخزّن URL + bookName بـ key قصير "s<counter>"
// ══════════════════════════════════════════════

const sessionStore = new Map<string, SessionEntry>();
let sessionCounter = 0;

function storeSession(entry: Omit<SessionEntry, "ts">): string {
  // BUG-6 FIX: كان يزيد sessionCounter إلى ما لا نهاية → بعد Number.MAX_SAFE_INTEGER يتصرف بشكل غير متوقع
  // الحل: نحصر الرقم بـ 1 مليون → لا تصادم عملي (الـ store أقصاه 2000 مدخل)
  sessionCounter = (sessionCounter % 1_000_000) + 1;
  const key = `s${sessionCounter}`;
  sessionStore.set(key, { ...entry, ts: Date.now() });

  if (sessionStore.size > 2000) {
    const hour = 60 * 60 * 1000;
    const now  = Date.now();
    for (const [k, v] of sessionStore.entries())
      if (now - v.ts > hour) sessionStore.delete(k);

    // LRU eviction لو التنظيف بالوقت لم يكفِ:
    // Map يحتفظ بترتيب الإدراج → أول 500 مفتاح هم الأقدم
    // استخدام iteration مباشر بدل sort() → O(n) بدل O(n log n)
    if (sessionStore.size > 1800) {
      let evicted = 0;
      for (const k of sessionStore.keys()) {
        if (evicted++ >= 500) break;
        sessionStore.delete(k);
      }
    }
  }
  return key;
}

/** جلب entry من الـ store */
export function getSession(key: string): SessionEntry | undefined {
  return sessionStore.get(key);
}

/** حذف entry بعد استخدامه */
export function deleteSession(key: string): void {
  sessionStore.delete(key);
}

/** تخزين رابط feedback مع bookName */
export function storeFeedbackUrl(url: string, bookName: string): string {
  return storeSession({ type: "feedback", url, bookName });
}

// ══════════════════════════════════════════════
// RETRY KEY CACHE — dedup: نفس الكتاب يعيد استخدام مفتاحه
// ══════════════════════════════════════════════

const retryKeyCache = new Map<string, { key: string; ts: number }>();

export function storeRetryKey(bookName: string): string {
  const normKey = normalizeForCache(bookName);
  const cached = retryKeyCache.get(normKey);
  if (
    cached &&
    Date.now() - cached.ts < RETRY_KEY_TTL &&
    sessionStore.has(cached.key)
  ) {
    return cached.key;
  }
  const newKey = storeSession({ type: "retry", bookName });
  retryKeyCache.set(normKey, { key: newKey, ts: Date.now() });
  if (retryKeyCache.size > 500) cleanRetryKeyCache();
  return newKey;
}

// ── Cleanup ──────────────────────────────────

export function cleanSessionStore(): void {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  for (const [k, v] of sessionStore.entries())
    if (now - v.ts > hour) sessionStore.delete(k);
}

export function cleanRetryKeyCache(): void {
  const now = Date.now();
  for (const [k, v] of retryKeyCache.entries())
    if (now - v.ts > RETRY_KEY_TTL) retryKeyCache.delete(k);
}

// ملاحظة: sessionStoreSize() حُذفت — لم تُستدعَ من أي مكان خارج هذا الملف
