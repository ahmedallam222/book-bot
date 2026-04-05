import type { SourceConfig } from "./types.js";

// ══════════════════════════════════════════════
// BOOK SOURCES — 12 مصدر
//
// isArabic: true  → موقع عربي متخصص بالكتب العربية
//           false → موقع دولي
//
// المواقع المُزالة نهائياً:
//   archive.org   — يفشل 10+ مرات/يوم ويرسل ملفات خاطئة
//   noor-book.com — يرجع محتوى عشوائي لا علاقة له بالكتاب
//
// يُستخدم isArabic في engine.ts لـ:
//   1. إضافة "pdf" للـ query (يرفع نتائج التحميل في Firecrawl)
//   2. تفعيل lang:"ar" + country:"SA" للمواقع العربية فقط
//   3. تجميع المواقع في مجموعتين (Unified Search — يوفر 85% من credits)
// ══════════════════════════════════════════════

const ALL_SOURCES: SourceConfig[] = [
  // ── مواقع عربية متخصصة ──────────────────────
  { domain: "foulabook.com",     name: "مكتبة فولة",    emoji: "📗", priority:  1, isArabic: true,  searchUrl: (q) => `https://foulabook.com/ar/search?q=${encodeURIComponent(q)}` },
  { domain: "kutub-pdf.net",     name: "كتب PDF",        emoji: "📕", priority:  2, isArabic: true,  searchUrl: (q) => `https://www.kutub-pdf.net/search?q=${encodeURIComponent(q)}` },
  { domain: "hindawi.org",       name: "هنداوي",         emoji: "📓", priority:  3, isArabic: true,  searchUrl: (q) => `https://www.hindawi.org/search/?q=${encodeURIComponent(q)}` },
  { domain: "books-library.net", name: "مكتبة الكتب",   emoji: "📙", priority:  4, isArabic: true,  searchUrl: (q) => `https://books-library.net/search?q=${encodeURIComponent(q)}` },
  { domain: "islamhouse.com",    name: "إسلام هاوس",    emoji: "🕌", priority:  5, isArabic: true,  searchUrl: (q) => `https://islamhouse.com/ar/search/?q=${encodeURIComponent(q)}&t=books` },
  { domain: "kotobati.com",      name: "كتوباتي",        emoji: "📖", priority:  6, isArabic: true,  searchUrl: (q) => `https://www.kotobati.com/search?q=${encodeURIComponent(q)}` },
  { domain: "waqfeya.net",       name: "الوقفية",        emoji: "📜", priority:  7, isArabic: true,  searchUrl: (q) => `https://waqfeya.net/search.php?st=${encodeURIComponent(q)}` },
  { domain: "mhtktb.com",        name: "مكتبة مكتبتي",  emoji: "📚", priority:  8, isArabic: true,  searchUrl: (q) => `https://mhtktb.com/?s=${encodeURIComponent(q)}` },
  // ── مصادر عربية جديدة (v19+) ────────────────
  { domain: "ktab.cc",           name: "كتاب",           emoji: "🔖", priority:  9, isArabic: true,  searchUrl: (q) => `https://ktab.cc/search?q=${encodeURIComponent(q)}` },
  { domain: "islamweb.net",      name: "إسلام ويب",      emoji: "🌙", priority: 10, isArabic: true,  searchUrl: (q) => `https://www.islamweb.net/ar/library/?q=${encodeURIComponent(q)}` },
  { domain: "al-mostafa.com",    name: "المصطفى",        emoji: "📿", priority: 11, isArabic: true,  searchUrl: (q) => `https://www.al-mostafa.com/search/?q=${encodeURIComponent(q)}` },
  // ── مواقع دولية ─────────────────────────────
  { domain: "pdfdrive.com",      name: "PDF Drive",      emoji: "💾", priority: 12, isArabic: false, searchUrl: (q) => `https://www.pdfdrive.com/search?q=${encodeURIComponent(q)}` },
];

// ملاحظة: SOURCES تُستخدم للـ UI (لوحة الإدارة) وعدد المصادر في رسالة الترحيب
// تعطيل مصدر من admin يضبط Redis key: src:off:{domain}
// engine.ts يقرأ هذه الـ keys ويفلتر المصادر وفقاً لها

/** قائمة كل المصادر */
export const SOURCES = ALL_SOURCES;

/** المواقع العربية فقط — تُستخدم في Unified Arabic Search */
// IMP-3 FIX: كان (s.isArabic !== false) → مصادر مستقبلية بدون isArabic تذهب للعربية خطأً
// الآن: شرط صريح (=== true) — أي مصدر جديد يجب أن يُحدَّد isArabic صراحةً
export const ARABIC_SOURCES = ALL_SOURCES.filter((s) => s.isArabic === true);

/** المواقع الدولية — تُستخدم في Unified International Search */
export const INTL_SOURCES   = ALL_SOURCES.filter((s) => s.isArabic === false);
