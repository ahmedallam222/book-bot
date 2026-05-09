import type { SourceConfig } from "./types.js";

// ══════════════════════════════════════════════
// SOURCES — مصادر البحث (عربية فقط) — v30
// ══════════════════════════════════════════════

export const ARABIC_SOURCES: SourceConfig[] = [
  {
    domain:    "archive.org",
    name:      "Internet Archive",
    emoji:     "🏛️",
    priority:  1,
    isArabic:  true,
    searchUrl: (q) =>
      `https://archive.org/search?query=${encodeURIComponent(q + " arabic")}&mediatype=texts`,
  },
  {
    domain:    "noor-book.com",
    name:      "مكتبة نور",
    emoji:     "🌙",
    priority:  2,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.noor-book.com/%D8%A8%D8%AD%D8%AB?q=${encodeURIComponent(q)}`,
  },
  {
    // ar.welib.st — مرآة عربية لـ Anna's Archive / Z-Library
    // المصدر محمي بـ Cloudflare بالكامل. Firecrawl غالباً يلاقي صفحات
    // /md5/{hash} في فهرس Google (لأنها مفهرسة)، وبعد كده welibResolver
    // (Playwright) بيدخل الموقع، يستنّى الـ wait-then-reveal counter،
    // وياخد الـ signed URL على welib-public.org. شوف server/bot/welibResolver.ts.
    domain:    "welib.st",
    name:      "ويليب",
    emoji:     "📚",
    priority:  3,
    isArabic:  true,
    searchUrl: (q) =>
      `https://ar.welib.st/search?index=&q=${encodeURIComponent(q)}`,
  },
  {
    domain:    "hindawi.org",
    name:      "هنداوي",
    emoji:     "📗",
    priority:  3,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.hindawi.org/books/?search=${encodeURIComponent(q)}`,
  },
  {
    domain:    "waqfeya.net",
    name:      "المكتبة الوقفية",
    emoji:     "📖",
    priority:  4,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.waqfeya.net/search.php?keyword=${encodeURIComponent(q)}`,
  },
  {
    domain:    "al-maktaba.org",
    name:      "المكتبة الشاملة",
    emoji:     "📚",
    priority:  5,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.al-maktaba.org/search?keyword=${encodeURIComponent(q)}`,
  },
  {
    domain:    "books-library.net",
    name:      "مكتبة الكتب",
    emoji:     "📗",
    priority:  6,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.books-library.net/search?q=${encodeURIComponent(q)}`,
  },
  {
    domain:    "kotobati.com",
    name:      "كتوباتي",
    emoji:     "📘",
    priority:  7,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.kotobati.com/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "foulabook.com",
    name:      "فولة بوك",
    emoji:     "📕",
    priority:  8,
    isArabic:  true,
    searchUrl: (q) =>
      `https://foulabook.com/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "novbook.net",
    name:      "نوف بوك",
    emoji:     "📓",
    priority:  9,
    isArabic:  true,
    searchUrl: (q) =>
      `https://novbook.net/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "arabic-book.net",
    name:      "الكتاب العربي",
    emoji:     "📙",
    priority:  10,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.arabic-book.net/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "ktabpdf.com",
    name:      "كتاب PDF",
    emoji:     "📄",
    priority:  11,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.ktabpdf.com/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "kutub-pdf.net",
    name:      "كتب PDF",
    emoji:     "🗂️",
    priority:  12,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.kutub-pdf.net/searching.html?q=${encodeURIComponent(q)}`,
  },
  {
    domain:    "kutubm.com",
    name:      "كتوبم",
    emoji:     "📑",
    priority:  13,
    isArabic:  true,
    searchUrl: (q) =>
      `https://www.kutubm.com/?s=${encodeURIComponent(q)}`,
  },
  {
    domain:    "mktbtypdf.com",
    name:      "مكتبتي PDF",
    emoji:     "📕",
    priority:  14,
    isArabic:  true,
    searchUrl: (q) =>
      `https://mktbtypdf.com/?s=${encodeURIComponent(q)}`,
  },
  // kutubdl.site removed 2026-05-09: turned out to be a content-farm
  // SEO domain — landing pages contain only descriptive text and zero
  // outbound PDF / drive / mediafire links. Adding it polluted Firecrawl
  // results with false candidates that always failed (response is HTML
  // not PDF). The bot's "no direct PDF — try landing page" fallback was
  // exhausting attempts on these dead pages instead of falling through
  // to working sources.
];

export const INTL_SOURCES: SourceConfig[] = [];
export const SOURCES: SourceConfig[] = [...ARABIC_SOURCES];
