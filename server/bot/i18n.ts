// ══════════════════════════════════════════════
// i18n — foundation for Arabic (default) + English
//
// Locale stored: ret:locale:{userId} = "ar" | "en"
// Default: ar
// ══════════════════════════════════════════════

import { redis } from "./redis.js";

export type Locale = "ar" | "en";

const KEY = (uid: string) => `ret:locale:${uid}`;

type Dict = Record<string, string>;

const AR: Dict = {
  "brand.name": "رفيق",
  "brand.tagline": "يجلب إليك الكتب PDF بيُسر",
  "maint.title": "رفيق في صيانة خفيفة حالياً",
  "maint.body": "سنعود قريباً… شكراً لصبرك.",
  "help.title": "كيف تستخدم رفيق؟",
  "welcome.first": "أهلاً — أنا رفيق. اكتب عنوان أي كتاب…",
  "welcome.back": "أهلاً بعودتك. اكتب عنوان كتاب أو استخدم الأزرار.",
  "error.temp": "خطأ مؤقت، حاول مرة أخرى.",
  "banned": "تم حظرك من استخدام رفيق.",
  "search.prompt": "اكتب عنوان الكتاب في المحادثة الآن.",
  "locale.set.ar": "تم ضبط اللغة: العربية",
  "locale.set.en": "Language set: English",
  "locale.hint": "غيّر اللغة: /lang en أو /lang ar",
};

const EN: Dict = {
  "brand.name": "Rafiq",
  "brand.tagline": "Fetches Arabic book PDFs for you",
  "maint.title": "Rafiq is under light maintenance",
  "maint.body": "We'll be back shortly. Thanks for your patience.",
  "help.title": "How to use Rafiq?",
  "welcome.first": "Hi — I'm Rafiq. Type any book title…",
  "welcome.back": "Welcome back. Type a book title or use the buttons.",
  "error.temp": "Temporary error, please try again.",
  "banned": "You are banned from using Rafiq.",
  "search.prompt": "Type the book title in the chat now.",
  "locale.set.ar": "تم ضبط اللغة: العربية",
  "locale.set.en": "Language set: English",
  "locale.hint": "Change language: /lang en or /lang ar",
};

const TABLES: Record<Locale, Dict> = { ar: AR, en: EN };

export function isLocale(s: string): s is Locale {
  return s === "ar" || s === "en";
}

export async function getUserLocale(userId: string): Promise<Locale> {
  try {
    const v = await redis.get(KEY(userId));
    if (v === "en" || v === "ar") return v;
  } catch { /* */ }
  return "ar";
}

export async function setUserLocale(userId: string, locale: Locale): Promise<void> {
  await redis.set(KEY(userId), locale, "EX", 800 * 86400);
}

export function t(locale: Locale, key: string, fallback?: string): string {
  return TABLES[locale][key] || TABLES.ar[key] || fallback || key;
}

export async function tu(userId: string, key: string, fallback?: string): Promise<string> {
  const locale = await getUserLocale(userId);
  return t(locale, key, fallback);
}

/** Detect locale from Telegram language_code (best-effort). */
export function localeFromTelegram(langCode?: string | null): Locale {
  if (!langCode) return "ar";
  const lc = langCode.toLowerCase();
  if (lc.startsWith("ar")) return "ar";
  if (lc.startsWith("en")) return "en";
  return "ar";
}

export const SUPPORTED_LOCALES: Locale[] = ["ar", "en"];
