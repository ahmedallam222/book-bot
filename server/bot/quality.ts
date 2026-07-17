// ══════════════════════════════════════════════
// QUALITY — شفافية التسليم (لماذا نثق بهذا الملف؟)
// ══════════════════════════════════════════════

import { escMd } from "./text.js";

export interface QualityInput {
  bookName: string;
  sourceUrl?: string;
  sizeMB?: string;
  fromCache?: boolean;
  isSuspect?: boolean;
  isPrem?: boolean;
}

function domainOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** نطاقات معروفة بكتب عربية (إشارة ثقة للعرض فقط) */
const TRUSTED_HINTS = [
  "shamela",
  "archive.org",
  "waqfeya",
  "noor-book",
  "noorbook",
  "hindawi",
  "standardebooks",
  "pdf",
  "drive.google",
  "telegram",
  "t.me",
  "welib",
  "library",
];

function trustLabel(domain: string | null, fromCache: boolean, isSuspect: boolean): string {
  if (isSuspect) return "مراجعة يدوية مستحسنة";
  if (fromCache) return "نسخة مجرّبة سابقاً";
  if (!domain) return "مصدر مفهرس";
  const d = domain.toLowerCase();
  if (TRUSTED_HINTS.some((h) => d.includes(h))) return "مصدر معروف في الفهرس";
  return "مصدر مفهرس";
}

/**
 * سطر/كتلة عربية فصحى توضح جودة التسليم للمستخدم.
 */
export function buildQualityBlock(q: QualityInput): string {
  const domain = domainOf(q.sourceUrl);
  const trust = trustLabel(domain, !!q.fromCache, !!q.isSuspect);
  const size =
    q.sizeMB && q.sizeMB !== "?"
      ? `الحجم ≈ *${escMd(String(q.sizeMB))} MB*`
      : null;
  const path = q.fromCache ? "تسليم سريع (من ذاكرة رفيق)" : "بحث جديد ثم تحقق";
  const match = q.isSuspect
    ? "⚠︎ تطابق غير مؤكد — راجع العنوان"
    : "✓ اجتاز فحوصات التطابق المتاحة (ليست ضماناً مطلقاً)";

  const bits = [
    `◦ المسار: ${path}`,
    `◦ الثقة: ${trust}`,
    `◦ ${match}`,
  ];
  if (size) bits.push(`◦ ${size}`);
  if (domain && !q.fromCache) {
    bits.push(`◦ المضيف: \`${escMd(domain.slice(0, 40))}\``);
  }

  return (
    `\n\n🛡 *جودة التسليم*\n` +
    bits.join("\n") +
    `\n_إن لم يكن الملف مطابقاً: استخدم «ليس هذا الكتاب؟»_`
  );
}
