import { randomBytes } from "crypto";
import { redis } from "./redis.js";

// ══════════════════════════════════════════════
// SESSION — جلسات مؤقتة للـ callbacks
// ══════════════════════════════════════════════
//
// Telegram callback_data محدود بـ 64 بايت — لا يكفي لتخزين URL + bookName.
// نحتفظ بالبيانات في Redis ونبعت مفتاحاً قصيراً (12 hex char) في الـ
// callback_data.
//
// FIX-SESSION-PERSIST:
// كان التخزين في Map داخل ذاكرة العملية → كل restart يقتل أزرار "أعد
// الإرسال" / "احفظ للاحقاً" / "📘ملخص" لكل المستخدمين بصمت (الـ key
// لا يوجد، بدائل النجاح لا تظهر، المستخدم يضغط بلا فائدة). أيضاً:
//   - عند بلوغ الحد 5,000 entry كان `enforceLimit()` يقوم بـ O(N log N)
//     sort في الـ hot path لكل ضغطة زر.
//   - النشر متعدد-المثيلات (multi-instance) كان مستحيلاً.
//
// الآن: Redis مع EX 24h. لا حدود في-ذاكرة، إخراج O(1)، صمود أمام restart،
// قابلية النشر متعدد-المثيلات.
//
// التواقيع تبقى متزامنة (sync return للـ key) لأن المستدعين يستخدمون الـ
// key مباشرة في كائنات keyboard markup. الـ write للـ Redis fire-and-forget
// — في حالة فشل Redis (نادر، Redis مشترك مع طبقات حرجة أخرى) المستخدم
// سيرى "session not found" بدلاً من crash، وهو سلوك أكثر أماناً من ضياع
// الجلسة بصمت.

interface SessionEntry {
  bookName?: string;
  url?:      string;
}

const SESSION_KEY = (k: string) => `sess:${k}`;
const SESSION_TTL_SEC = 24 * 3600;

function newKey(): string {
  return randomBytes(6).toString("hex");
}

function writeSession(key: string, entry: SessionEntry): void {
  // fire-and-forget — الكتابة شبه فورية على Redis محلي (<2ms)؛ لو فشلت
  // المستخدم يرى "session not found" بدل تأخير الواجهة.
  redis.set(SESSION_KEY(key), JSON.stringify(entry), "EX", SESSION_TTL_SEC)
    .catch(() => {});
}

export async function getSession(key: string): Promise<SessionEntry | undefined> {
  try {
    const raw = await redis.get(SESSION_KEY(key));
    if (!raw) return undefined;
    return JSON.parse(raw) as SessionEntry;
  } catch {
    return undefined;
  }
}

export async function deleteSession(key: string): Promise<void> {
  try { await redis.del(SESSION_KEY(key)); } catch {}
}

export function storeRetryKey(bookName: string): string {
  const key = newKey();
  writeSession(key, { bookName });
  return key;
}

export function storeFeedbackUrl(url: string, bookName: string): string {
  const key = newKey();
  writeSession(key, { url, bookName });
  return key;
}

// Stores both bookName and the source URL the file was delivered from,
// so the summary callback can re-download the PDF for AI analysis.
// `url` is optional — for cache-served deliveries we may not have a
// fresh sourceUrl, in which case the summary path falls back to text-
// only providers using Wikipedia context.
export function storeSummaryKey(bookName: string, url?: string): string {
  const key = newKey();
  writeSession(key, { bookName, url });
  return key;
}
