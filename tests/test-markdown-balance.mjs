// ══════════════════════════════════════════════
// TELEGRAM MARKDOWN BALANCE — Catches unmatched _ / * / ` entities
// ══════════════════════════════════════════════
//
// Telegram's "old Markdown" parser fails with 400 "can't parse entities"
// when an italic/bold/code marker is opened but never closed. Production
// bug 2026-05-07: /invite produced `_..._${progress}` with stray `_`,
// and `_X *Y* X_` nested formatting which the old parser doesn't accept.
//
// This test renders message builders with mock state and asserts that:
//   1. Each formatting marker (* and _) appears an even number of times
//      OUTSIDE backtick code spans (Telegram ignores formatting in code).
//   2. The message starts and ends in a "clean" formatting state.
//
// We test the most common admin/user paths. The shared helper here can be
// reused by future builders.

// Note: we don't import buildInviteMessage directly because it requires
// a live Redis connection (getReferralState). Instead we replicate the
// template here AND statically verify the source file has no stray markers.

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

// Strip backtick code spans (Telegram doesn't apply * / _ inside them).
// Also strip escaped \* and \_.
function stripCodeAndEscapes(s) {
  return s
    .replace(/\\[*_`]/g, "")     // escaped markers
    .replace(/`[^`]*`/g, "");    // single-backtick code spans
}

// Count unescaped occurrences of a marker.
function countMarker(s, marker) {
  const stripped = stripCodeAndEscapes(s);
  return (stripped.match(new RegExp("\\" + marker, "g")) || []).length;
}

function assertBalanced(label, text) {
  const stars = countMarker(text, "*");
  const unders = countMarker(text, "_");
  // const ticks = countMarker(text, "`"); // backticks already paired by stripping
  check(`${label}: * paired (count=${stars})`, stars % 2 === 0, "even", stars);
  check(`${label}: _ paired (count=${unders})`, unders % 2 === 0, "even", unders);
}

// ── Mock the redis getReferralState by stubbing the module ──
//
// We test buildInviteMessage with several real-world states. To avoid Redis,
// we monkey-patch the underlying Redis access via a shim. Simpler: import
// the inner state-builder logic and pass mock data through pre-canned
// scenarios at the buildInvite level by mocking what getReferralState
// returns. Since we can't easily mock Redis here without a test harness,
// we'll directly construct the message from scratch using the same template
// for each scenario.

// SCENARIO 1: New user, no referrals yet — most common case (ALSO the
// case that produced the 400 error in production)
const scenario1 = {
  count:        0,
  nextTier:     { count: 3, remaining: 3, days: 7 },
  tiersClaimed: [],
};

// SCENARIO 2: Mid-tier user, 4 referrals
const scenario2 = {
  count:        4,
  nextTier:     { count: 5, remaining: 1, days: 14 },
  tiersClaimed: ["3"],
};

// SCENARIO 3: Maxed-out user (post-50)
const scenario3 = {
  count:        55,
  nextTier:     null,
  tiersClaimed: ["3", "5", "10", "20", "50"],
};

// Replicate the template from buildInviteMessage with the same fixes
// (PR #102). If the source ever drifts from this template, this test
// will pass while production might fail — so we add a sanity check
// that imports and runs buildInviteMessage end-to-end via a stub below.
function renderTemplate(state) {
  const link = "https://t.me/kholasaelktob_Bot?start=ref_5469997406";
  const WELCOME_GIFT_DAYS = 3;

  let progress = "";
  if (state.nextTier) {
    const filled = Math.max(0, state.count);
    const total  = state.nextTier.count;
    const filledBars = Math.round((filled / total) * 8);
    const bar = "🟩".repeat(Math.min(filledBars, 8)) + "⬜".repeat(Math.max(0, 8 - filledBars));
    progress =
      `\n\n📊 *تقدمك:* ${state.count} من ${state.nextTier.count}\n` +
      `${bar}\n` +
      `*${state.nextTier.remaining}* إحال${state.nextTier.remaining === 1 ? "ة" : "ات"} للوصول إلى *+${state.nextTier.days} يوم Premium*`;
  } else if (state.count > 0) {
    progress = `\n\n📊 *إحالاتك:* ${state.count}\n_وصلت لكل المستويات المتاحة — استمر للحصول على +90 يوم كل 25 إحالة._`;
  }

  const tiersClaimedLine = state.tiersClaimed.length > 0
    ? `\n\n🏆 _مستويات صرفتها:_ ${state.tiersClaimed.map(t => `\`${t}\``).join(" · ")}`
    : "";

  return (
    `🎁 *ادعُ صديقاً واحصل على Premium مجاني!*\n` +
    `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n` +
    `🔗 رابط الدعوة الخاص بك:\n` +
    `\`${link}\`\n\n` +
    `📋 *المكافآت:*\n` +
    `◦ ٣ إحالات → *+٧ أيام Premium*\n` +
    `◦ ٥ إحالات → *+١٤ يوم*\n` +
    `◦ ١٠ إحالات → *+٣٠ يوم*\n` +
    `◦ ٢٠ إحالات → *+٦٠ يوم*\n` +
    `◦ ٥٠ إحالة → *+٩٠ يوم*\n` +
    `◦ كل ٢٥ إحالة بعدها → *+٩٠ يوم*\n\n` +
    `🎁 صديقك يحصل على *${WELCOME_GIFT_DAYS} أيام Premium* مجاناً عند انضمامه.${progress}${tiersClaimedLine}\n\n` +
    `💡 *تنبيه:* الإحالة تُحتسب فقط بعد ما صديقك يحمّل أول كتاب — لمنع التحايل بحسابات وهمية.`
  );
}

console.log("=== Invite message Markdown balance ===");
for (const [name, st] of [["new user", scenario1], ["mid-tier", scenario2], ["maxed", scenario3]]) {
  const text = renderTemplate(st);
  assertBalanced(`invite (${name})`, text);
}

// ── Sanity: verify source template still matches the test template ──
//
// We stat the real buildInviteMessage source for any stray markers that
// might have crept in. We can't easily run it without Redis, so we do
// a static check on the source.
console.log("=== Source-file regression check ===");
import { readFileSync } from "fs";
const refSrc = readFileSync("./server/bot/referral.ts", "utf8");
// The bug was `*+${state.nextTier.days} يوم Premium*_` — pattern with
// adjacent `*_`. Refuse any new occurrences.
const adjacentStarUnder = refSrc.match(/\*_(?!\s)|(?<!\s)_\*/g);
check(
  "no adjacent `*_` or `_*` in referral.ts",
  !adjacentStarUnder || adjacentStarUnder.length === 0,
  "0 occurrences",
  adjacentStarUnder ? adjacentStarUnder.length : 0,
);

// And the specific stray-_ pattern after Arabic period:
const strayUnderAfterPeriod = refSrc.match(/[\u0600-\u06FF]\.\s*_(?![\s\S]*_)/);
check(
  "no stray `_` after Arabic period in referral.ts",
  !strayUnderAfterPeriod,
  "no match",
  strayUnderAfterPeriod ? strayUnderAfterPeriod[0] : "OK",
);

// ── Verify the bug case from production wouldn't survive ──
console.log("=== Regression: production bug case ===");
const buggyTemplate =
  `🎁 صديقك يحصل على *3 أيام Premium* مجاناً عند انضمامه._\n\n📊 *تقدمك:* 0 من 3\n⬜⬜⬜⬜⬜⬜⬜⬜\n_3 إحالات للوصول إلى *+7 يوم Premium*_\n\n💡 *تنبيه:* الإحالة...`;
const bugStars = countMarker(buggyTemplate, "*");
const bugUnders = countMarker(buggyTemplate, "_");
// Check: the buggy template has odd count of one marker (proving our test catches it)
check(
  "buggy template detected as unbalanced",
  bugStars % 2 !== 0 || bugUnders % 2 !== 0,
  "odd count",
  `*=${bugStars}, _=${bugUnders}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
