// Tests Cairo timezone helpers — verifies dates/reset countdown anchor
// to Africa/Cairo, NOT UTC.
import { cairoDateString, msUntilCairoMidnight, buildResetTime } from "./server/bot/text.js";

let pass = 0, fail = 0;
function ok(name, cond, info = "") { if (cond) pass++; else fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? ` (${info})` : ""}`); }

// — basic shape —
const today = cairoDateString();
ok("cairoDateString format YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today), today);

// — exact value at known epoch —
// 2026-05-05T22:30:00 Cairo (DST active: UTC+3) = 2026-05-05T19:30:00Z
const dstDay = new Date("2026-05-05T19:30:00Z");
ok("Cairo 22:30 DST = same date 2026-05-05", cairoDateString(dstDay) === "2026-05-05", cairoDateString(dstDay));

// 2026-05-05T22:00:00Z → Cairo 01:00 next day (UTC+3) → 2026-05-06
const afterMidnight = new Date("2026-05-05T22:00:00Z");
ok("Cairo 01:00 after Cairo midnight rolls forward", cairoDateString(afterMidnight) === "2026-05-06", cairoDateString(afterMidnight));

// 2026-01-15T23:30:00 Cairo (winter: UTC+2) = 2026-01-15T21:30:00Z
const winterLate = new Date("2026-01-15T21:30:00Z");
ok("Cairo 23:30 winter = 2026-01-15", cairoDateString(winterLate) === "2026-01-15", cairoDateString(winterLate));

// 2026-01-15T00:30:00 Cairo = 2026-01-14T22:30:00Z → 2026-01-15
const winterEarly = new Date("2026-01-14T22:30:00Z");
ok("Cairo 00:30 winter = 2026-01-15", cairoDateString(winterEarly) === "2026-01-15", cairoDateString(winterEarly));

// — msUntilCairoMidnight —
// At 2026-05-05T19:30:00Z = Cairo 22:30 → 1.5h = 5,400,000 ms remain
const at22h30 = new Date("2026-05-05T19:30:00Z");
const ms22h30 = msUntilCairoMidnight(at22h30);
ok("Cairo 22:30 → ~1.5h to midnight", Math.abs(ms22h30 - 5_400_000) < 1000, `${ms22h30}ms`);

// At 2026-05-05T21:00:00Z = Cairo 00:00 → 24h = 86,400,000 ms (next midnight)
const atMidnight = new Date("2026-05-05T21:00:00Z");
const msMidnight = msUntilCairoMidnight(atMidnight);
ok("Cairo 00:00 → 24h to next midnight", Math.abs(msMidnight - 86_400_000) < 1000, `${msMidnight}ms`);

// — buildResetTime sanity (just shape, content depends on now) —
const reset = buildResetTime();
ok("buildResetTime returns Arabic string", typeof reset === "string" && reset.length > 0, reset);
ok("buildResetTime no negative numbers", !/-\d/.test(reset), reset);

// — Critical bug demo —
// At 22:30 Cairo, the OLD UTC code would say "متبقي ~5 ساعات" because
// UTC midnight is at 02:00 Cairo. The NEW Cairo code says "~1.5 ساعة".
// We test by computing both and confirming they differ.
const utcMidnightAt2230 = (() => {
  const d = new Date(at22h30);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() - at22h30.getTime();
})();
ok("UTC and Cairo midnight differ at 22:30 Cairo (regression check)",
  Math.abs(utcMidnightAt2230 - ms22h30) > 1_000_000, // > 16min difference
  `utcMs=${utcMidnightAt2230}, cairoMs=${ms22h30}, diff=${utcMidnightAt2230 - ms22h30}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
