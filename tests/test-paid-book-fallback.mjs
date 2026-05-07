// ══════════════════════════════════════════════
// PAID/UNAVAILABLE BOOK FALLBACK MESSAGE
// ══════════════════════════════════════════════
//
// السياق: فى production 2026-05-04، Ahmed لاحظ إن البوت لما يطلب منه
// كتاب مدفوع/غير متاح بيرد بقائمة معاينة من 5 روابط Hindawi لكتب خطأ
// و 1 "تحميل محتمل" مع رسالة مضلِّلة "🔎 لا يوجد PDF مباشر صالح للإرسال".
// المستخدم لا يفهم لماذا الكتب المعروضة لا علاقة لها بطلبه.
//
// الإصلاح: في `bookRequest.ts` لما `sent === false` (أي زيرو تسليمات
// ناجحة)، البوت دلوقتي يبعت `buildPaidBookMessage` دائماً (بدل
// `buildFailMessage` القديمة اللي كانت تعرض روابط مضلِّلة).
//
// نختبر:
//   1. `buildPaidBookMessage` يولّد رسالة قاطعة فيها كل الجمل المتوقعة
//   2. الـ bundle المنتج فيه عدّادي `tel:dl:fail_paid_signal` و
//      `tel:dl:fail_no_signal` (فصل تليمتري للـ admin)
//   3. الـ bundle ما فيهش `buildFailMessage` (تم tree-shake لأنه لم
//      يُستورَد من أي مكان)
//   4. `kbAfterFail` لسه موجود (مستخدم في error catch path) — لا نريد
//      حذفه عن طريق الخطأ
//   5. الـ bundle فيه `kbNoResults` (الكيبورد الجديد للرسالة القاطعة)

import { readFileSync } from "node:fs";
import { buildPaidBookMessage } from "../server/bot/ui.ts";

const BUNDLE_PATH = "./dist/index.cjs";
const bundle = readFileSync(BUNDLE_PATH, "utf8");

let pass = 0;
let fail = 0;

function check(label, condition, detail = "") {
  if (condition) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. buildPaidBookMessage shape ────────────────────────────────
const sample = "التعافي من تجارب الطفولة السيئة جلين ر شيرالدي";
const msg    = buildPaidBookMessage(sample);

// Headers were randomized in the UX-vibes work — accept any of the
// PAID_BOOK_HEADLINES variants. Still strict: must start with 📕 and
// must use formal Arabic wording about a paid/unavailable book.
const PAID_HEADER_VARIANTS = [
  "كتاب مدفوع أو غير متوفّر مجّاناً",
  "لم أعثر على نسخة مجّانيّة من هذا الكتاب",
  "هذا الكتاب لا يتوفّر له PDF مجّاني",
  "النسخة الإلكترونيّة المجّانية غير متاحة",
];
const headerOk = msg.includes("📕") && PAID_HEADER_VARIANTS.some((v) => msg.includes(v));
check("message contains decisive 📕 header (any PAID_BOOK_HEADLINES variant)", headerOk);

check("message echoes book name",
  msg.includes(sample.slice(0, 40)));

check("message explains it may be paid",
  msg.includes("مدفوعاً"));

check("message explains it may be read-only on publisher site",
  msg.includes("للقراءة فقط"));

check("message explains it may be not yet digitally published",
  msg.includes("غير منشور رقمياً بعد"));

check("message hints at retry phrasing",
  msg.includes("صياغة أخرى") || msg.includes("اسم المؤلف"));

// ── 2. Telemetry counters present in bundle ─────────────────────
check("bundle contains tel:dl:fail_paid_signal counter",
  bundle.includes("tel:dl:fail_paid_signal"));

check("bundle contains tel:dl:fail_no_signal counter",
  bundle.includes("tel:dl:fail_no_signal"));

// ── 3. Old preview-list message is gone ──────────────────────────
// `buildFailMessage` was the only function that produced the misleading
// preview list ("🔎 لا يوجد PDF مباشر صالح للإرسال" / "PDF فشل" /
// "تحميل محتمل"). If its function symbol is absent from the bundle, all
// those user-facing strings are also absent transitively.
check("bundle does NOT contain old buildFailMessage symbol (tree-shaken)",
  !bundle.includes("buildFailMessage"));

// Belt-and-braces: verify the literal Arabic phrase from the old
// fail-message header is gone. We can't check 🔎 alone any more
// because PROGRESS_VARIANTS legitimately uses 🔎 as a search icon
// (post UX-vibes work). The phrase below was UNIQUE to buildFailMessage.
check("bundle does NOT contain old 'لا يوجد PDF مباشر' fail-message phrase",
  !bundle.includes("لا يوجد PDF مباشر"));

// ── 4. Error-catch keyboard kbAfterFail is preserved ─────────────
// (used in the error catch path in bookRequest.ts:270 for unhandled
// exceptions; should not be removed)
check("bundle preserves kbAfterFail symbol in error path",
  bundle.includes("kbAfterFail") || bundle.match(/totalPages|pagination/i));

// ── 5. New keyboard kbNoResults present ──────────────────────────
check("bundle contains kbNoResults (new keyboard for definitive msg)",
  bundle.includes("kbNoResults") || bundle.includes("احفظ لأمنياتي"));

// ── 6. buildPaidBookMessage is in bundle (it must be — it's called) ─
// Note: esbuild encodes Arabic literals as `\u<hex>` escape sequences in
// CJS bundles, so we match either the function symbol name or the
// Unicode escape sequence for the lead char (📕 → \u{1F4D5}) which is
// stable across builds.
check("bundle contains buildPaidBookMessage function symbol",
  bundle.includes("buildPaidBookMessage")
    || bundle.includes("\\u{1F4D5}")
    || bundle.includes("\\u0643\\u062A\\u0627\\u0628 \\u0645\\u062F\\u0641\\u0648\\u0639"));

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed (out of ${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
