// ════════════════════════════════════════════════════════════════
// AUDIT 2026-05-04 — BUG B: Summary cache key uses canonicalize
// ════════════════════════════════════════════════════════════════
//
// السياق: قبل الإصلاح `summary.ts:cacheKey` يستخدم `normalizeForCache`
// (Arabic-letter-folding فقط) بينما الـ inflight summary lock
// (`summaryHandler.ts`) والـ DB cache يستخدمون `canonicalizeForCache`
// (clean + normalize). نتيجة: نفس الكتاب بصياغات مختلفة يحفر مفاتيح
// كاش منفصلة → استدعاءات Gemini مكررة (مدفوعة).
//
// مثال:
//   "أرض زيكولا"           → normalizeForCache: "ارض زيكولا"
//   "تحميل أرض زيكولا pdf" → normalizeForCache: "تحميل ارض زيكولا pdf"  ❌
//   "ارض زيكولا"           → normalizeForCache: "ارض زيكولا"
//
//   مع canonicalizeForCache كل التلت → "ارض زيكولا" ✓
//
// نختبر:
//   K1: source — `summary.ts` يستخدم canonicalizeForCache
//   K2: parity — 4 صياغات لنفس الكتاب يولّدوا نفس الـ cacheKey

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeForCache } from "../server/bot/text.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`); fail++; }
}

// ── K1: source change ──────────────────────────────────────────
console.log("=== K1: source uses canonicalizeForCache ===");

const summarySrc = fs.readFileSync(
  path.join(__dirname, "../server/bot/summary.ts"), "utf8",
);

// Locate the cacheKey function and assert it uses canonicalizeForCache.
const cacheKeyMatch = summarySrc.match(/function cacheKey\([^)]*\): string \{[^}]*\}/s);
check("cacheKey() function found",
  !!cacheKeyMatch, true, !!cacheKeyMatch);

if (cacheKeyMatch) {
  check("cacheKey() body uses canonicalizeForCache",
    cacheKeyMatch[0].includes("canonicalizeForCache"),
    true, cacheKeyMatch[0].includes("canonicalizeForCache"));

  check("cacheKey() body no longer uses normalizeForCache",
    !cacheKeyMatch[0].match(/\bnormalizeForCache\(/),
    "absent",
    cacheKeyMatch[0].match(/\bnormalizeForCache\(/) ? "present" : "absent");
}

// ── K2: parity — same canonical form for noisy phrasings ────────
console.log("\n=== K2: phrasings of same book canonicalize to same key ===");

// Mirror the cacheKey() logic locally — guards against drift.
const CACHE_PREFIX = "summary:cache:";
function cacheKey(bookName) {
  return CACHE_PREFIX + (canonicalizeForCache(bookName) || bookName).slice(0, 200);
}

const groups = [
  {
    label: "أرض زيكولا (Arabic with hamza variants + filler)",
    phrasings: [
      "أرض زيكولا",
      "ارض زيكولا",
      "تحميل أرض زيكولا pdf",
      "كتاب ارض زيكولا مجاناً",
    ],
  },
  {
    label: "العادات السبع (taa marbuta variant)",
    phrasings: [
      "العادات السبع",
      "العادات السبع pdf",
      "تحميل كتاب العادات السبع",
    ],
  },
  {
    // English: cleanSearchQuery only strips a known set of fillers
    // ("pdf", "download", and Arabic descriptors). We assert the
    // noise stripping it DOES handle.
    label: "Atomic Habits (English case + pdf filler)",
    phrasings: [
      "Atomic Habits",
      "atomic habits pdf",
      "ATOMIC HABITS",
    ],
  },
];

for (const g of groups) {
  const keys = g.phrasings.map(cacheKey);
  const allSame = keys.every((k) => k === keys[0]);
  check(`'${g.label}' — ${g.phrasings.length} phrasings → 1 cache key`,
    allSame, "all equal", allSame ? "all equal" : `keys=${JSON.stringify(keys)}`);
}

// ── K3: different books → different keys ────────────────────────
console.log("\n=== K3: different books → different keys ===");

const k1 = cacheKey("أرض زيكولا");
const k2 = cacheKey("العادات السبع");
const k3 = cacheKey("Atomic Habits");
check("'أرض زيكولا' ≠ 'العادات السبع'", k1 !== k2, "≠", `${k1} vs ${k2}`);
check("'أرض زيكولا' ≠ 'Atomic Habits'", k1 !== k3, "≠", `${k1} vs ${k3}`);
check("'العادات السبع' ≠ 'Atomic Habits'", k2 !== k3, "≠", `${k2} vs ${k3}`);

// ════════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));
if (fail > 0) process.exit(1);
process.exit(0);
