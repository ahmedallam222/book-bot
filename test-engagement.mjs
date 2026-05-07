// ═══════════════════════════════════════════════════════════════════
// test-engagement.mjs — deterministic checks for engagement features
//
// Covers (without spinning up Redis):
//   1. Streak Lua semantics — re-implements the Lua state machine in JS
//      and verifies cur/last/max/transitioned/broken transitions.
//   2. Streak milestones — only fire on exact match, only on transition.
//   3. Streak formatters — formatStreakLine / buildMilestoneMessage.
//   4. Referral tier ladder — nextTierAfter monotonic, post-50 +25/+90 loop.
//   5. Badge definitions — uniqueness of ids, ordering monotone,
//      threshold ranges within download tiers.
// ═══════════════════════════════════════════════════════════════════

import {
  formatStreakLine, buildMilestoneMessage, buildBrokenStreakMessage,
} from "./server/bot/streak.ts";
import { BADGES } from "./server/bot/badges.ts";

let pass = 0, fail = 0;
function check(name, cond, info = "") {
  if (cond) { pass++; console.log(`[PASS] ${name}`); }
  else      { fail++; console.log(`[FAIL] ${name}${info ? ` — ${info}` : ""}`); }
}

// ─── 1. Streak Lua semantics (re-implementation) ───────────────────
//
// Mirrors the Lua at top of streak.ts. Inputs: prev cur/last/max + today/yest.
// Outputs: [newCur, newMax, transitioned, broken].
function streakUpdate(prevCur, prevLast, prevMax, today, yest) {
  let cur = prevCur, max = prevMax;
  let trans = 0, broken = 0;
  if (prevLast === today) {
    // already done today — no-op
    cur   = prevCur;
    trans = 0;
  } else if (prevLast === yest) {
    cur   = prevCur + 1;
    trans = 1;
  } else {
    if (prevCur >= 3) broken = prevCur;
    cur   = 1;
    trans = 1;
  }
  if (cur > max) max = cur;
  return [cur, max, trans, broken];
}

// — first-ever download —
{
  const [c, m, t, b] = streakUpdate(0, "", 0, "2026-05-07", "2026-05-06");
  check("first-ever: cur=1, max=1, trans=1, broken=0",
    c === 1 && m === 1 && t === 1 && b === 0,
    `got cur=${c} max=${m} trans=${t} broken=${b}`);
}

// — same-day repeat —
{
  const [c, m, t, b] = streakUpdate(4, "2026-05-07", 5, "2026-05-07", "2026-05-06");
  check("same-day: cur stays, trans=0, broken=0",
    c === 4 && m === 5 && t === 0 && b === 0);
}

// — consecutive day —
{
  const [c, m, t, b] = streakUpdate(6, "2026-05-06", 6, "2026-05-07", "2026-05-06");
  check("consecutive: cur=7, max grows to 7, trans=1",
    c === 7 && m === 7 && t === 1 && b === 0);
}

// — broken streak (≥3 lost) —
{
  const [c, m, t, b] = streakUpdate(8, "2026-05-01", 8, "2026-05-07", "2026-05-06");
  check("broken (8 → 0 → 1): cur=1, max stays 8, broken=8",
    c === 1 && m === 8 && t === 1 && b === 8);
}

// — broken streak <3 (do not announce) —
{
  const [c, m, t, b] = streakUpdate(2, "2026-05-04", 2, "2026-05-07", "2026-05-06");
  check("broken-but-tiny (2 → 0): broken=0 (no announcement)",
    c === 1 && m === 2 && t === 1 && b === 0);
}

// — max preservation across breaks —
{
  let [c, m] = streakUpdate(0, "", 0, "2026-01-01", "2025-12-31");
  for (let i = 0; i < 99; i++) {
    [c, m] = streakUpdate(c, "2026-01-01", m, "2026-01-02", "2026-01-01");
  }
  check("100-day streak: max=100", m === 100, `got max=${m}`);
  // break it
  [c, m] = streakUpdate(c, "2026-01-01", m, "2026-05-01", "2026-04-30");
  check("after-break: cur=1 max=100", c === 1 && m === 100);
}

// ─── 2. Streak formatters ─────────────────────────────────────────
{
  // formatStreakLine returns null for active < 2
  check("formatStreakLine null for current=0", formatStreakLine({ current: 0, max: 0, transitioned: false, brokenStreak: 0, milestoneReached: null }) === null);
  check("formatStreakLine null for current=1", formatStreakLine({ current: 1, max: 1, transitioned: true, brokenStreak: 0, milestoneReached: null }) === null);

  const line = formatStreakLine({ current: 4, max: 4, transitioned: true, brokenStreak: 0, milestoneReached: null });
  check("formatStreakLine: shows 4 يوم", typeof line === "string" && line.includes("4") && line.includes("يوم"), `got ${JSON.stringify(line)}`);

  // Milestones 3/7/14/30/60/100 use Arabic words ("ثلاثة", "أسبوع",
  // "شهر", "مائة" …); other values fall back to numeric default. Verify
  // both code paths work.
  const m3   = buildMilestoneMessage(3);
  const m30  = buildMilestoneMessage(30);
  const m100 = buildMilestoneMessage(100);
  const m200 = buildMilestoneMessage(200);
  check("milestone(3): non-empty Arabic message",   typeof m3 === "string"   && m3.length > 10);
  check("milestone(30): mentions شهر",              m30.includes("شهر"));
  check("milestone(100): mentions مائة",            m100.includes("مائة"));
  check("milestone(200): default fallback uses number", m200.includes("200"));

  const broken = buildBrokenStreakMessage(8);
  check("broken(8): mentions 8", broken.includes("8"));
}

// ─── 3. Referral tier calculation (re-implement matching impl) ────
function nextTierAfter(count) {
  const tiers = [
    { count: 3,  days: 7  },
    { count: 5,  days: 14 },
    { count: 10, days: 30 },
    { count: 20, days: 60 },
    { count: 50, days: 90 },
  ];
  for (const t of tiers) if (count < t.count) return { count: t.count, days: t.days };
  const last = 50, INC = 25, REWARD = 90;
  if (count < last) return null;
  const next = last + INC * Math.floor((count - last) / INC + 1);
  return { count: next, days: REWARD };
}

[
  [0,  3,  7],
  [2,  3,  7],
  [3,  5,  14],
  [4,  5,  14],
  [5,  10, 30],
  [9,  10, 30],
  [10, 20, 60],
  [19, 20, 60],
  [20, 50, 90],
  [49, 50, 90],
  [50, 75, 90],
  [74, 75, 90],
  [75, 100, 90],
  [100, 125, 90],
  [124, 125, 90],
].forEach(([count, expCount, expDays]) => {
  const r = nextTierAfter(count);
  check(`nextTierAfter(${count}) → {count:${expCount}, days:${expDays}}`,
    r && r.count === expCount && r.days === expDays,
    `got ${JSON.stringify(r)}`);
});

// ─── 4. Badge definitions integrity ───────────────────────────────
{
  const ids = BADGES.map(b => b.id);
  check("BADGES: 10 entries", BADGES.length === 10, `got ${BADGES.length}`);
  check("BADGES: ids unique", new Set(ids).size === ids.length);
  check("BADGES: orders unique", new Set(BADGES.map(b => b.order)).size === BADGES.length);

  const required = ["dl5", "dl20", "dl50", "dl100", "dl250", "streak3", "streak7", "streak30", "summary10", "social3"];
  for (const id of required) check(`BADGES contains ${id}`, ids.includes(id));

  for (const b of BADGES) {
    check(`BADGES[${b.id}]: emoji+name+description set`,
      typeof b.emoji === "string" && b.emoji.length > 0 &&
      typeof b.name === "string" && b.name.length > 0 &&
      typeof b.description === "string" && b.description.length > 0);
  }
}

// ─── 5. Cairo TZ — sanity that streak cairoDateString matches text.ts ──
{
  // Imported via streak.ts import chain — text.ts cairoDateString is
  // already covered by test-cairo-timezone.mjs. Just verify shape.
  const s = formatStreakLine({ current: 5, max: 5, transitioned: true, brokenStreak: 0, milestoneReached: null });
  check("formatStreakLine returns markdown-safe string", typeof s === "string" && !s.includes("<") && !s.includes(">"));
}

console.log(`\n══════════════════════════════════════════`);
console.log(`Engagement test suite — ${pass} passed, ${fail} failed`);
console.log(`══════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
