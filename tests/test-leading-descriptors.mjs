// Tests Bug #9: descriptor words (كتاب/رواية/قصة) are stripped from
// LEADING position only, never from inside a book title. This prevents
// cache pollution where "كتاب الموتى" and "الموتى" (different books)
// would otherwise canonicalize to the same key.
import { cleanSearchQuery, canonicalizeForCache } from "../server/bot/text.js";

let pass = 0, fail = 0;
function ok(name, cond, info = "") { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`); }
function eq(name, actual, expected) { ok(`${name}: "${actual}" === "${expected}"`, actual === expected); }
function neq(name, a, b) { ok(`${name}: "${a}" !== "${b}"`, a !== b); }

// — Leading descriptors get stripped (preserves PR #38 behavior) —
eq("leading كتاب", cleanSearchQuery("كتاب الفقه الأصغر"), "الفقه الأصغر");
eq("leading رواية", cleanSearchQuery("رواية الفيل الأزرق"), "الفيل الأزرق");
eq("leading قصة", cleanSearchQuery("قصة الجزيرة"), "الجزيرة");
eq("leading كتب", cleanSearchQuery("كتب الفلسفة"), "الفلسفة");
eq("leading روايات", cleanSearchQuery("روايات نجيب محفوظ"), "نجيب محفوظ");
eq("leading قصص", cleanSearchQuery("قصص الأنبياء"), "الأنبياء");
eq("leading قصه (no taa)", cleanSearchQuery("قصه قصيرة"), "قصيرة");
eq("leading روايه (no taa)", cleanSearchQuery("روايه الجريمة"), "الجريمة");
eq("leading كتيب", cleanSearchQuery("كتيب صغير"), "صغير");

// — Double leading: stack of intent + descriptor —
eq("تحميل + كتاب", cleanSearchQuery("تحميل كتاب أرض زيكولا"), "أرض زيكولا");
eq("لخصلي + كتاب", cleanSearchQuery("لخصلي كتاب صديقي الملحد"), "صديقي الملحد");
eq("اريد + رواية", cleanSearchQuery("اريد رواية مدفعجية الملك"), "مدفعجية الملك");

// — Critical: descriptors INSIDE titles are preserved (Bug #9 main fix) —
eq("preserves كتاب in middle", cleanSearchQuery("فن كتاب الجريمة"), "فن كتاب الجريمة");
eq("preserves رواية in middle", cleanSearchQuery("سحر رواية المؤامرة"), "سحر رواية المؤامرة");
eq("preserves قراءة in middle", cleanSearchQuery("فن قراءة العقول"), "فن قراءة العقول");
eq("preserves قصة in middle", cleanSearchQuery("بداية قصة قصيرة"), "بداية قصة قصيرة");
eq("preserves حمل in middle", cleanSearchQuery("في حمل العنزة"), "في حمل العنزة");
eq("preserves اقرأ in middle", cleanSearchQuery("اول اقرأ باسم ربك"), "اول اقرأ باسم ربك");

// — Anywhere words still stripped (regression check) —
eq("strips pdf anywhere", cleanSearchQuery("أرض زيكولا pdf"), "أرض زيكولا");
eq("strips مجانا anywhere", cleanSearchQuery("مجانا أرض زيكولا"), "أرض زيكولا");
eq("strips كامل anywhere", cleanSearchQuery("الفيل الأزرق كامل"), "الفيل الأزرق");
eq("strips epub trailing", cleanSearchQuery("الفيل الأزرق epub"), "الفيل الأزرق");

// — CRITICAL: titles with descriptors INSIDE keep distinct cache keys —
// (this is the actual bug we're fixing — middle/end stripping)
const k1 = canonicalizeForCache("فن قراءة العقول"); // user wants Henrik Fexeus book
const k2 = canonicalizeForCache("فن العقول");        // different/non-existent
neq("CRITICAL — فن قراءة العقول ≠ فن العقول (PR#38 regression)", k1, k2);

const m1 = canonicalizeForCache("سحر رواية المؤامرة"); // hypothetical title with رواية inside
const m2 = canonicalizeForCache("سحر المؤامرة");       // shorter different title
neq("CRITICAL — سحر رواية المؤامرة ≠ سحر المؤامرة", m1, m2);

const n1 = canonicalizeForCache("في حمل العنزة");
const n2 = canonicalizeForCache("في العنزة");
neq("CRITICAL — في حمل العنزة ≠ في العنزة", n1, n2);

// — Leading equivalence preserved (intentional cache-merge) —
// "كتاب X" and "X" SHOULD share cache because users often add "كتاب"
// as a generic prefix (parseBookName behaves the same way).
const p1 = canonicalizeForCache("كتاب أرض زيكولا");
const p2 = canonicalizeForCache("أرض زيكولا");
ok(`leading كتاب canonicalizes to same key as bare title (${p1} === ${p2})`, p1 === p2);

// — Cache canonicalization still merges intent+pdf with bare title (regression) —
const d1 = canonicalizeForCache("تحميل أرض زيكولا pdf");
const d2 = canonicalizeForCache("ارض زيكولا");
ok(`canonicalizeForCache merges intent+pdf with bare title (${d1} === ${d2})`, d1 === d2);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
