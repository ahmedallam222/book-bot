// ══════════════════════════════════════════════
// CACHE KEY NORMALIZATION + RE-VALIDATION (BUG-2/3/6/7/8)
// ══════════════════════════════════════════════
//
// السياق: قبل هذا الـ PR كان `storage.normalizeQuery` بيعمل
// `toLowerCase().trim().replace(/\s+/g, " ")` فقط — بدون تطبيع عربي
// ولا إزالة كلمات حشو. النتيجة:
//   - "أرض زيكولا" و "ارض زيكولا" مفاتيح كاش منفصلة
//   - "تحميل كتاب أرض زيكولا pdf" و "أرض زيكولا" مفاتيح منفصلة
//
// الإصلاح: storage بقى يستخدم `canonicalizeForCache` من text.ts
// اللي بتجمع `cleanSearchQuery` + `normalizeArabic` + space normalize.
//
// كمان: cache-hit re-validation (BUG-3) يرفض هيت كاش لما الكتاب
// المخزَّن لا يطابق طلب المستخدم بنسبة كافية.

import {
  canonicalizeForCache,
  normalizeArabic,
  normalizeForCache,
  cleanSearchQuery,
  urlFilenameRelevance,
} from "./server/bot/text.ts";

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) {
    console.log(`[PASS] ${name}`);
    pass++;
  } else {
    console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
    fail++;
  }
}

// ── N1: canonicalizeForCache equates Arabic variants ─────────
console.log("=== N1: canonicalizeForCache equates equivalent queries ===");

const N1_cases = [
  // hamza variants
  ["أرض زيكولا",   "ارض زيكولا"],
  ["إعصار",        "اعصار"],
  ["آدم",          "ادم"],
  // taa marbuta vs haa
  ["مدرسة الحياة", "مدرسه الحياه"],
  // alif maqsura vs ya
  ["مصطفى",        "مصطفي"],
  // tashkeel removed
  ["كَلِيلَة",     "كليله"],
  // filler words removed (cleanSearchQuery)
  ["تحميل كتاب أرض زيكولا pdf مجاناً", "أرض زيكولا"],
  ["رواية أرض زيكولا للكاتب",          "أرض زيكولا للكاتب"],
];

for (const [a, b] of N1_cases) {
  const ca = canonicalizeForCache(a);
  const cb = canonicalizeForCache(b);
  check(`'${a}' ≡ '${b}'`, ca === cb, ca, cb);
}

// ── N2: canonicalize is idempotent ─────────────────────────
console.log("=== N2: canonicalizeForCache idempotent ===");
const N2_inputs = ["أرض زيكولا", "تحميل كتاب أرض زيكولا pdf", "كَلِيلَة ودمنة"];
for (const q of N2_inputs) {
  const once  = canonicalizeForCache(q);
  const twice = canonicalizeForCache(once);
  check(`f(f(${q})) === f(${q})`, once === twice, once, twice);
}

// ── N3: cleanSearchQuery DOESN'T strip core book words ──────
console.log("=== N3: cleanSearchQuery preserves real titles ===");
const N3_cases = [
  ["1984",                          "1984"],
  ["العادات السبع",                 "العادات السبع"],
  ["فن اللامبالاة",                 "فن اللامبالاة"],
  // edge: query that's ENTIRELY filler — must fall back to original
  ["تحميل pdf مجانا",               "تحميل pdf مجانا"],
];
for (const [input, expected] of N3_cases) {
  const got = cleanSearchQuery(input);
  check(`cleanSearchQuery('${input}')`, got === expected, expected, got);
}

// ── R1: cache-hit re-validation (BUG-3) ─────────────────────
//
// نعيد إنتاج المنطق محلياً (verbatim) لأن الدالة في bookRequest.ts
// تستورد Redis. لو غيّرت الإصلاح هناك، حدّث هذه النسخة.
console.log("=== R1: cacheHitMatchesQuery re-validation ===");

function cacheHitMatchesQuery(requestedBook, cachedBookName, sourceUrl) {
  const reqTokens = canonicalizeForCache(requestedBook)
    .split(/\s+/).filter((w) => w.length >= 3);
  const cachedTokens = new Set(
    canonicalizeForCache(cachedBookName)
      .split(/\s+/).filter((w) => w.length >= 3),
  );
  if (reqTokens.length === 0 || cachedTokens.size === 0) return true;
  const matched = reqTokens.filter((w) => cachedTokens.has(w)).length;
  const overlap = matched / reqTokens.length;
  if (overlap >= 0.40) return true;
  const filenameScore = sourceUrl ? urlFilenameRelevance(requestedBook, sourceUrl) : 0;
  if (filenameScore >= 0.40) return true;
  return false;
}

const R1_cases = [
  // طلب == مخزَّن (الحالة الشائعة) → match
  {
    name: "exact match → pass",
    req: "العادات السبع",
    cachedName: "العادات السبع",
    url: "https://example.org/files/العادات-السبع.pdf",
    expected: true,
  },
  // اختلاف hamza/taa (ساكت بعد التطبيع) → match
  {
    name: "hamza variant → still pass (canonicalize handles it)",
    req: "أرض زيكولا",
    cachedName: "ارض زيكولا",
    url: "https://example.org/files/ارض-زيكولا.pdf",
    expected: true,
  },
  // طلب مختلف تماماً عن المخزَّن → fail
  {
    name: "completely different cached name → reject (poisoned hit)",
    req: "العمل العميق",
    cachedName: "تاريخ الفلسفة اليونانية",
    url: "https://downloads.hindawi.org/books/19204286.pdf",
    expected: false,
  },
  // طلب شريك في كلمة واحدة فقط من 4 (overlap 25%) — لا URL signal
  {
    name: "weak token overlap + opaque URL → reject",
    req: "تاريخ مصر القديم الكامل",
    cachedName: "تاريخ روما الحديث المجلد",
    url: "https://example.org/files/12345.pdf",
    expected: false,
  },
  // نفس الـ overlap الضعيف لكن URL filename match قوي → accept
  {
    name: "weak token overlap + strong URL signal → accept",
    req: "تاريخ مصر القديم الكامل",
    cachedName: "اسم مختلف",
    url: "https://example.org/files/تاريخ-مصر-القديم-الكامل.pdf",
    expected: true,
  },
  // overlap = 50% (2 من 4) → accept
  {
    name: "50% overlap → accept",
    req: "تاريخ مصر القديم الكامل",
    cachedName: "تاريخ مصر",
    url: "https://example.org/files/x.pdf",
    expected: true,
  },
];

for (const c of R1_cases) {
  const got = cacheHitMatchesQuery(c.req, c.cachedName, c.url);
  check(c.name, got === c.expected, c.expected, got);
}

// ══════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════
console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));

if (fail > 0) process.exit(1);
process.exit(0);
