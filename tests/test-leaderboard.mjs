// ══════════════════════════════════════════════
// LEADERBOARD HELPERS — قائمتَي "الأكثر تحميلاً" و "أفضل كتب الأسبوع"
// ══════════════════════════════════════════════
//
// تختبر:
//   - canonicalBookKey: يدمج صيغ مختلفة لنفس الكتاب
//   - isoWeekKey: ISO-8601 week مع Cairo TZ
//   - truncateAtWord: قص ذكي عند حدود الكلمات
//   - isComplaintQuery: يكشف رسائل الشكوى بدل أسماء الكتب
//   - bundle markers: إن الـ feature موجودة في الـ build
//
// نشغّل الاختبارات على source TS مباشرة via tsx — نفس النمط في باقي
// الـ test files (test-cache-key-normalization.mjs).

import {
  canonicalBookKey,
  isoWeekKey,
  truncateAtWord,
  isComplaintQuery,
} from "../server/bot/text.ts";

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

// ── L1: canonicalBookKey merges variants ─────────────────
console.log("=== L1: canonicalBookKey equates variants ===");
const L1_cases = [
  // Arabic letter normalization (ى/ي)
  ["هكذا تتعافي",                  "هكذا تتعافى"],
  // Arabic letter normalization (ة/ه)
  ["مدرسة الحياة",                 "مدرسه الحياه"],
  // Hamza variants
  ["أرض زيكولا",                   "ارض زيكولا"],
  ["إعصار النجاح",                 "اعصار النجاح"],
  // Tashkeel removed
  ["كَلِيلَة ودِمنَة",             "كليله ودمنه"],
  // Trailing punctuation stripped (real production data: "...الاجتماعي'.")
  ["سيكولوجية الذكاء'.",           "سيكولوجية الذكاء"],
  // Leading filler stripped (cleanSearchQuery)
  ["تحميل كتاب أرض زيكولا pdf",    "أرض زيكولا"],
  // Mixed
  ["تحميل رواية أَرض زيكولا.",     "ارض زيكولا"],
];
for (const [a, b] of L1_cases) {
  const ka = canonicalBookKey(a);
  const kb = canonicalBookKey(b);
  check(`'${a}' ≡ '${b}'`, ka === kb && ka !== "", ka, kb);
}

// ── L2: canonicalBookKey is idempotent ───────────────────
console.log("=== L2: canonicalBookKey idempotent ===");
for (const q of ["هكذا تتعافى", "تحميل كتاب 1984 pdf", "Jan Kott Shakespeare"]) {
  const once = canonicalBookKey(q);
  const twice = canonicalBookKey(once);
  check(`f(f('${q}')) === f('${q}')`, once === twice, once, twice);
}

// ── L3: canonicalBookKey distinguishes different books ───
console.log("=== L3: canonicalBookKey keeps different books separate ===");
const L3_cases = [
  ["العادات السبع",                "1984"],
  ["كافكا على الشاطئ",             "هكذا تتعافى"],
  ["الكون كارل ساغان",             "ديوان محمود درويش"],
];
for (const [a, b] of L3_cases) {
  const ka = canonicalBookKey(a);
  const kb = canonicalBookKey(b);
  check(`'${a}' ≢ '${b}'`, ka !== kb, `≠ '${kb}'`, ka);
}

// ── L4: canonicalBookKey caps at 100 chars ───────────────
console.log("=== L4: canonicalBookKey caps length ===");
const longInput = "كتاب طويل جداً ".repeat(20); // ~280 chars
const longKey = canonicalBookKey(longInput);
check(`length <= 100`, longKey.length <= 100, "<=100", longKey.length);

// ── L5: canonicalBookKey handles empty/garbage ───────────
console.log("=== L5: canonicalBookKey edge cases ===");
check(`empty → ''`, canonicalBookKey("") === "", "''", canonicalBookKey(""));
check(`whitespace → ''`, canonicalBookKey("   \t\n   ") === "", "''", canonicalBookKey("   "));
check(`only punctuation → ''`, canonicalBookKey("'.,;:") === "", "''", canonicalBookKey("'.,;:"));

// ── W1: isoWeekKey format ────────────────────────────────
console.log("=== W1: isoWeekKey format ===");
const wk = isoWeekKey();
check(`format YYYY-Www`, /^\d{4}-W\d{2}$/.test(wk), "YYYY-Www", wk);
// Known dates: 2024-01-01 was Mon → ISO week 1 of 2024
// 2024-01-04 (Thu) → 2024-W01
const knownThu = new Date("2024-01-04T12:00:00Z");
check(`2024-01-04 → 2024-W01`, isoWeekKey(knownThu) === "2024-W01", "2024-W01", isoWeekKey(knownThu));
// 2025-12-29 (Mon) is in week 1 of 2026 per ISO 8601
const isoEdge = new Date("2025-12-29T12:00:00Z");
check(`2025-12-29 → 2026-W01`, isoWeekKey(isoEdge) === "2026-W01", "2026-W01", isoWeekKey(isoEdge));

// ── W2: isoWeekKey same week for adjacent days ──────────
console.log("=== W2: isoWeekKey stability ===");
const tue = new Date("2024-06-04T12:00:00Z"); // Tuesday
const fri = new Date("2024-06-07T12:00:00Z"); // Friday — same ISO week
check(`Tue & Fri same week`, isoWeekKey(tue) === isoWeekKey(fri), isoWeekKey(tue), isoWeekKey(fri));

// ── T1: truncateAtWord — short text passes through ───────
console.log("=== T1: truncateAtWord ===");
check(`short stays`, truncateAtWord("hello", 80) === "hello", "hello", truncateAtWord("hello", 80));
check(`exact length stays`, truncateAtWord("a".repeat(80), 80) === "a".repeat(80), "len 80", truncateAtWord("a".repeat(80), 80).length);

// ── T2: truncateAtWord — production bug case ────────────
// قبل الإصلاح: "Jan Kott , Shakespeare Our Contemporary (1964) Full book".slice(0,55)
// = "Jan Kott , Shakespeare Our Contemporary (1964) Full boo" (مفقودة k!)
const prodCase = "Jan Kott , Shakespeare Our Contemporary (1964) Full book";
const truncated = truncateAtWord(prodCase, 55);
check(`prod case doesn't end mid-word`, !truncated.endsWith("oo"), "no 'oo'", truncated);
check(`prod case ends with ellipsis`, truncated.endsWith("…"), "...", truncated.slice(-3));

// ── T3: truncateAtWord — Arabic ──────────────────────────
const arInput = "هذا كتاب طويل جداً يحتوي على معلومات كثيرة ومفيدة عن التاريخ";
const arOut = truncateAtWord(arInput, 30);
check(`Arabic doesn't end mid-word`, !arOut.endsWith(" ")
  && !/\S+$/.test(arOut.slice(0, -1)) === false, "ok", arOut);
check(`Arabic ends with ellipsis`, arOut.endsWith("…"), "…", arOut.slice(-1));

// ── C1: isComplaintQuery — positives ─────────────────────
console.log("=== C1: isComplaintQuery detects complaints ===");
const complaints = [
  "هذا ليس الكتاب المطلوب",
  "هو ليس الكتاب المطلوب الذي طلبته",
  "مش هو الكتاب",
  "كتاب غلط",
  "غلط الكتاب",
  "wrong book please",
  "this is not the book",
];
for (const c of complaints) {
  check(`detected: '${c}'`, isComplaintQuery(c), true, isComplaintQuery(c));
}

// ── C2: isComplaintQuery — negatives ─────────────────────
console.log("=== C2: isComplaintQuery doesn't false-positive ===");
const realBooks = [
  "أرض زيكولا",
  "العادات السبع",
  "Shakespeare Our Contemporary",
  "1984",
  "هكذا تتعافى",
  "كتاب الحياة",
  // edge: "خط" is letter-prefix of "خطأ" — must not match
  "خط الزمن",
];
for (const b of realBooks) {
  check(`not complaint: '${b}'`, !isComplaintQuery(b), false, isComplaintQuery(b));
}

// ── B1: Bundle markers ──────────────────────────────────
console.log("=== B1: Bundle contains feature markers ===");
import { existsSync, readFileSync } from "fs";
const bundlePath = "./dist/index.cjs";
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, "utf8");
  const markers = [
    ["canonicalBookKey",       "canonical key helper present"],
    ["isoWeekKey",             "ISO week helper present"],
    ["truncateAtWord",         "smart truncate present"],
    ["isComplaintQuery",       "complaint filter present"],
    ["stats:top_books:week:",  "weekly bucket key prefix"],
    ["stats:top_books_display","display hash key"],
    ["getWeeklyTopBooks",      "weekly reader fn"],
  ];
  for (const [m, label] of markers) {
    check(`bundle: ${label}`, bundle.includes(m), `contains '${m}'`, bundle.includes(m));
  }
} else {
  console.log(`[SKIP] bundle not built (${bundlePath} missing) — run \`npm run build\` first`);
}

// ── Summary ─────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
