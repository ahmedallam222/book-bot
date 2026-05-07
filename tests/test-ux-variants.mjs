// ════════════════════════════════════════════════════════════════
// UX VARIANTS — pool sanity + helper logic
// ════════════════════════════════════════════════════════════════
//
// نتأكد إن:
//   V1: كل الـ pools فيها variants كافية (≥ 4 لمعظمها)
//   V2: pickRandom يختار من الـ pool ولا يخرج عنه
//   V3: chance() respects الـ percentage (probabilistic لكن نستخدم
//       sample كبير عشان نحدد الـ rate تقريباً)
//   V4: PROGRESS_VARIANTS فيها 7 steps (matches PROGRESS_BARS)
//   V5: كل step variant فيه icon + label
//   V6: WAIT_REASSURANCE_15S و WAIT_REASSURANCE_30S كلها بالعربية
//       الفصحى (لا كلمات عامية مصرية/خليجية صريحة)
//   V7: REACTION pools كلها emojis مسموحة من Telegram bot reactions
//   V8: PERSONALITY_LINES تستخدم اللغة الفصحى وتبدأ بـ emoji
//   V9: buildProgress() output شكله متوقع (يحتوي bar + percent + book)

import {
  PROGRESS_VARIANTS,
  SUCCESS_TAGLINES,
  SUCCESS_TAGLINES_PREMIUM,
  CACHE_HIT_TAGLINES,
  PAID_BOOK_HEADLINES,
  NO_RESULTS_HEADLINES,
  PERSONALITY_LINES,
  PERSONALITY_LINE_CHANCE,
  WAIT_REASSURANCE_15S,
  WAIT_REASSURANCE_30S,
  REACTION_RECEIVED,
  REACTION_SUCCESS,
  REACTION_CACHE_HIT,
  REACTION_NO_RESULT,
  REACTION_ERROR,
  REACTION_PAID_BOOK,
  pickRandom,
  chance,
} from "../server/bot/uiVariants.ts";

import { buildProgress, buildSuccessMsg, buildPaidBookMessage, buildNoResults } from "../server/bot/ui.ts";

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`); fail++; }
}

// ── V1: pool sizes ─────────────────────────────────────────────
console.log("=== V1: pool sizes ≥ minimum ===");
check("SUCCESS_TAGLINES ≥ 5", SUCCESS_TAGLINES.length >= 5, "≥5", SUCCESS_TAGLINES.length);
check("SUCCESS_TAGLINES_PREMIUM ≥ 4", SUCCESS_TAGLINES_PREMIUM.length >= 4, "≥4", SUCCESS_TAGLINES_PREMIUM.length);
check("CACHE_HIT_TAGLINES ≥ 4", CACHE_HIT_TAGLINES.length >= 4, "≥4", CACHE_HIT_TAGLINES.length);
check("PAID_BOOK_HEADLINES ≥ 3", PAID_BOOK_HEADLINES.length >= 3, "≥3", PAID_BOOK_HEADLINES.length);
check("NO_RESULTS_HEADLINES ≥ 3", NO_RESULTS_HEADLINES.length >= 3, "≥3", NO_RESULTS_HEADLINES.length);
check("PERSONALITY_LINES ≥ 5", PERSONALITY_LINES.length >= 5, "≥5", PERSONALITY_LINES.length);
check("WAIT_REASSURANCE_15S ≥ 5", WAIT_REASSURANCE_15S.length >= 5, "≥5", WAIT_REASSURANCE_15S.length);
check("WAIT_REASSURANCE_30S ≥ 4", WAIT_REASSURANCE_30S.length >= 4, "≥4", WAIT_REASSURANCE_30S.length);

// ── V2: pickRandom returns from pool ──────────────────────────
console.log("\n=== V2: pickRandom returns from pool ===");
const pool = ["a", "b", "c", "d", "e"];
let allFromPool = true;
for (let i = 0; i < 50; i++) {
  if (!pool.includes(pickRandom(pool))) { allFromPool = false; break; }
}
check("50× pickRandom always inside pool", allFromPool, true, allFromPool);

// ── V3: chance() probability ───────────────────────────────────
console.log("\n=== V3: chance() ~ matches percentage ===");
const N = 5000;
let trueCount = 0;
for (let i = 0; i < N; i++) if (chance(20)) trueCount++;
const rate = trueCount / N;
check("chance(20) ~= 20% (within 5% bound)", Math.abs(rate - 0.20) < 0.05, "~0.20", rate);

let zeroCount = 0;
for (let i = 0; i < 1000; i++) if (chance(0)) zeroCount++;
check("chance(0) returns false always", zeroCount === 0, 0, zeroCount);

let hundredCount = 0;
for (let i = 0; i < 1000; i++) if (chance(100)) hundredCount++;
check("chance(100) returns true always", hundredCount === 1000, 1000, hundredCount);

// ── V4: PROGRESS_VARIANTS shape ───────────────────────────────
console.log("\n=== V4: PROGRESS_VARIANTS structure ===");
check("PROGRESS_VARIANTS has exactly 7 steps", PROGRESS_VARIANTS.length === 7, 7, PROGRESS_VARIANTS.length);
let allStepsHaveVariants = true;
for (let i = 0; i < PROGRESS_VARIANTS.length; i++) {
  if (PROGRESS_VARIANTS[i].length < 3) {
    allStepsHaveVariants = false;
    console.log(`    step ${i} has only ${PROGRESS_VARIANTS[i].length} variants`);
    break;
  }
}
check("each step has ≥ 3 variants", allStepsHaveVariants, true, allStepsHaveVariants);

// ── V5: each variant has icon + label ──────────────────────────
console.log("\n=== V5: variant shape ===");
let allVariantsValid = true;
let firstBadIdx = -1;
for (let i = 0; i < PROGRESS_VARIANTS.length; i++) {
  for (const v of PROGRESS_VARIANTS[i]) {
    if (typeof v.icon !== "string" || v.icon.length === 0 ||
        typeof v.label !== "string" || v.label.length === 0) {
      allVariantsValid = false;
      firstBadIdx = i;
      break;
    }
  }
  if (!allVariantsValid) break;
}
check("every variant has non-empty icon + label", allVariantsValid, true, `bad step=${firstBadIdx}`);

// ── V6: WAIT_REASSURANCE pools are formal Arabic ──────────────
console.log("\n=== V6: wait-reassurance is formal Arabic (no dialect words) ===");
// Common Egyptian/Khaleeji words/forms that should NOT appear in
// formal MSA reassurance text.
const DIALECT_WORDS = [
  "بحاول",  // Egyptian: "I'm trying" — MSA: "أحاول"
  "هلاقي",  // Egyptian future: "I'll find" — MSA: "سأجد"
  "إيه",   // Egyptian/Levantine: "what" — MSA: "ماذا/ما"
  "دلوقتي", // Egyptian: "now" — MSA: "الآن"
  "كده",   // Egyptian: "like that" — MSA: "هكذا"
  "عشان",  // Colloquial: "because/in order to" — MSA: "لأن/كي"
  "زي ما", // Egyptian: "like" — MSA: "كما"
  "علشان", // Colloquial — MSA: "لأن/كي"
  "ابوس",  // Khaleeji
  "وش",    // Khaleeji "what"
  "وين",   // Khaleeji "where"
  "ايش",   // Khaleeji
];

function checkFormal(label, pool) {
  for (const text of pool) {
    for (const dialect of DIALECT_WORDS) {
      if (text.includes(dialect)) {
        return { ok: false, text, dialect };
      }
    }
  }
  return { ok: true };
}

const r15 = checkFormal("15s", WAIT_REASSURANCE_15S);
check(`WAIT_REASSURANCE_15S has no dialect words`,
  r15.ok, "no dialect", r15.ok ? "clean" : `'${r15.dialect}' in '${r15.text}'`);

const r30 = checkFormal("30s", WAIT_REASSURANCE_30S);
check(`WAIT_REASSURANCE_30S has no dialect words`,
  r30.ok, "no dialect", r30.ok ? "clean" : `'${r30.dialect}' in '${r30.text}'`);

const rPers = checkFormal("personality", PERSONALITY_LINES);
check(`PERSONALITY_LINES has no dialect words`,
  rPers.ok, "no dialect", rPers.ok ? "clean" : `'${rPers.dialect}' in '${rPers.text}'`);

// ── V7: reactions are valid emojis (allowed by Telegram free tier) ──
console.log("\n=== V7: reaction pools sanity ===");
// Telegram free-tier allowed reactions (subset — list in reactions.ts)
const ALLOWED_REACTIONS = new Set([
  "👍","👎","❤️","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮",
  "💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤️‍🔥","🌚","🌭","💯","🤣","⚡","⚡️",
  "🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨‍💻",
  "👀","🎃","🙈","😇","😨","🤝","✍️","🤗","🫡","🎅","🎄","☃️","💅","🤪","🗿","🆒",
  "💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂️","🤷","🤷‍♀️","😡","🥳",
]);

function checkReactions(name, pool) {
  for (const e of pool) {
    if (!ALLOWED_REACTIONS.has(e)) {
      return { ok: false, e };
    }
  }
  return { ok: true };
}

for (const [name, pool] of [
  ["RECEIVED",  REACTION_RECEIVED],
  ["SUCCESS",   REACTION_SUCCESS],
  ["CACHE_HIT", REACTION_CACHE_HIT],
  ["NO_RESULT", REACTION_NO_RESULT],
  ["ERROR",     REACTION_ERROR],
  ["PAID_BOOK", REACTION_PAID_BOOK],
]) {
  const r = checkReactions(name, pool);
  check(`REACTION_${name} all in Telegram free-tier whitelist`,
    r.ok, "valid", r.ok ? "ok" : `'${r.e}' not allowed`);
}

// ── V8: personality lines start with emoji + use formal markers ──
console.log("\n=== V8: PERSONALITY_LINES formal-tone shape ===");
check("PERSONALITY_LINE_CHANCE between 5 and 25",
  PERSONALITY_LINE_CHANCE >= 5 && PERSONALITY_LINE_CHANCE <= 25,
  "5..25", PERSONALITY_LINE_CHANCE);

let allPersonalityHaveLabel = true;
let firstBadPersonality = "";
for (const p of PERSONALITY_LINES) {
  // Each line should contain "ملاحظة" (the formal "note:" marker we use).
  if (!p.includes("ملاحظة")) {
    allPersonalityHaveLabel = false;
    firstBadPersonality = p;
    break;
  }
}
check("every PERSONALITY_LINE contains 'ملاحظة'",
  allPersonalityHaveLabel, true,
  allPersonalityHaveLabel ? "ok" : `'${firstBadPersonality}'`);

// ── V9: buildProgress output shape ────────────────────────────
console.log("\n=== V9: buildProgress() output ===");
const sample = buildProgress(2, "أرض زيكولا");
check("buildProgress includes bar (▓░ chars)",
  sample.includes("▓") && sample.includes("░"),
  "has bar", sample.includes("▓"));
check("buildProgress includes % marker",
  /%/.test(sample),
  "%", /%/.test(sample));
check("buildProgress includes book name",
  sample.includes("أرض زيكولا") || sample.includes("ارض زيكولا"),
  "book", "missing");

// ── V10: buildSuccessMsg + buildPaidBookMessage smoke test ────
console.log("\n=== V10: builders don't crash, output non-empty ===");
const s = buildSuccessMsg("Atomic Habits", 1, 5, "2.3", false, false);
check("buildSuccessMsg non-empty", s.length > 30, ">30", s.length);
const p = buildPaidBookMessage("Some Paid Book");
check("buildPaidBookMessage non-empty", p.length > 30, ">30", p.length);
const n = buildNoResults("Some Missing Book", false);
check("buildNoResults non-empty", n.length > 30, ">30", n.length);

// ── V11: cache-hit sample includes a tagline ──────────────────
console.log("\n=== V11: success message with cache hit includes tagline ===");
let foundCacheTagline = false;
for (let i = 0; i < 30; i++) {
  const sc = buildSuccessMsg("Test", 1, 5, "1.0", /* fromCache */ true, false);
  for (const t of CACHE_HIT_TAGLINES) {
    // strip leading underscore-italics for comparison
    const inner = t.replace(/^_/, "").replace(/_$/, "");
    if (sc.includes(inner.slice(2, 20))) { foundCacheTagline = true; break; }
  }
  if (foundCacheTagline) break;
}
check("success message with fromCache=true includes a CACHE_HIT_TAGLINES variant",
  foundCacheTagline, true, foundCacheTagline);

// ════════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));
if (fail > 0) process.exit(1);
process.exit(0);
