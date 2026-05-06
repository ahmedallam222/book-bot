// Tests admin daily digest — alertWatcher fires once per day (Cairo TZ)
// at DAILY_DIGEST_HOUR_CAIRO and sends a summary to ADMIN_IDS.
//
// Pure-formatter (`buildDailyDigestMessage`) is the single source of truth
// for message shape — we test it deterministically against synthetic inputs
// without touching Redis/Telegram.
//
// Run from repo root: npx tsx test-daily-digest.mjs
import fs from "fs";
import {
  buildDailyDigestMessage,
  yesterdayCairoKey,
} from "./server/bot/dailyDigest.ts";
import {
  DAILY_DIGEST_HOUR_CAIRO,
  DAILY_DIGEST_DISABLED,
} from "./server/bot/config.ts";
import { cairoHourNumber, cairoDateString } from "./server/bot/text.ts";

let pass = 0, fail = 0;
const expect = (label, ok, got, want) => {
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (ok) pass++; else fail++;
};

// ── Test 1: env-tunables exist with sane defaults ───────────────
{
  expect("DAILY_DIGEST_HOUR_CAIRO default 9",
         DAILY_DIGEST_HOUR_CAIRO === 9,
         DAILY_DIGEST_HOUR_CAIRO, 9);
  expect("DAILY_DIGEST_DISABLED default false",
         DAILY_DIGEST_DISABLED === false,
         DAILY_DIGEST_DISABLED, false);
}

// ── Test 2: cairoHourNumber returns 0..23 integer ────────────────
{
  // Build a Date for 09:30 UTC. Cairo summer = UTC+3 → 12:30 Cairo.
  // Cairo winter = UTC+2 → 11:30 Cairo. So the answer is 11 or 12.
  const probe = new Date("2025-06-15T09:30:00Z");          // June → DST on
  const h     = cairoHourNumber(probe);
  expect("cairoHourNumber returns integer 0..23",
         Number.isInteger(h) && h >= 0 && h <= 23, h, "0..23");
  expect("cairoHourNumber Jun 09:30 UTC → 12 Cairo (UTC+3 DST)",
         h === 12, h, 12);

  const winter = new Date("2025-12-15T09:30:00Z");          // December → no DST
  const wh     = cairoHourNumber(winter);
  expect("cairoHourNumber Dec 09:30 UTC → 11 Cairo (UTC+2)",
         wh === 11, wh, 11);
}

// ── Test 3: yesterdayCairoKey is one day before cairoDateString ─
{
  const now      = new Date("2026-05-06T12:00:00Z");
  const today    = cairoDateString(now);                    // "2026-05-06"
  const ydayKey  = yesterdayCairoKey(now);                  // "2026-05-05"
  expect("yesterdayCairoKey lags today by exactly 1 day",
         today === "2026-05-06" && ydayKey === "2026-05-05",
         { today, ydayKey }, { today: "2026-05-06", ydayKey: "2026-05-05" });
}

// ── Test 4: full-feature message build ─────────────────────────
{
  const msg = buildDailyDigestMessage({
    reportDate:    "2026-05-05",
    activeUsers24h: 142,
    daily: {
      requests:   58,
      found:      47,
      downloads:  41,
      cache_hits: 6,
      searches:   89,
    },
    topBooks: [
      { book: "أرض زيكولا",       count: 12 },
      { book: "كليلة ودمنة",       count: 9 },
      { book: "حياتي مع جبران",   count: 7 },
    ],
    failingSources: [
      { domain: "downloads.hindawi.org", trustRate: 0.17, totalWithRejects: 76 },
      { domain: "scholar.archive.org",   trustRate: 0.09, totalWithRejects: 11 },
    ],
  });
  expect("message includes report date",   msg.includes("2026-05-05"),                 true, true);
  expect("message includes active users",  msg.includes("142"),                        true, true);
  expect("message includes success pct",   msg.includes("81.0%"),                      true, true);  // 47/58
  expect("message includes downloads",     msg.includes("41"),                         true, true);
  expect("message includes cache hits",    msg.includes("cache: 6"),                   true, true);
  expect("message lists top book #1",      msg.includes("1. أرض زيكولا"),             true, true);
  expect("message lists top book #3",      msg.includes("3. حياتي مع جبران"),         true, true);
  expect("message flags hindawi 17%",      msg.includes("downloads.hindawi.org") && msg.includes("17%"), true, true);
  expect("message flags scholar 9%",       msg.includes("scholar.archive.org") && msg.includes("9%"),   true, true);
  expect("message ends with /admin link",  msg.includes("/admin"),                     true, true);
}

// ── Test 5: empty-stats day still produces a sensible message ─
{
  const msg = buildDailyDigestMessage({
    reportDate:    "2026-05-05",
    activeUsers24h: 0,
    daily: {},
    topBooks: [],
    failingSources: [],
  });
  expect("zero requests → success pct shown as '—'",
         msg.includes("—"),
         true, true);
  expect("no failing sources → 'all sources above 30%' line",
         msg.includes("فوق 30%"),
         true, true);
  expect("active users 0 doesn't break formatting",
         /المستخدمون النشطون.*0/u.test(msg),
         true, true);
}

// ── Test 6: failingSources sorted worst-first, capped at 5 ─────
{
  const msg = buildDailyDigestMessage({
    reportDate:    "2026-05-05",
    activeUsers24h: 1,
    daily: { requests: 1, found: 1 },
    topBooks: [],
    failingSources: [
      { domain: "a.com", trustRate: 0.10, totalWithRejects: 10 },
      { domain: "b.com", trustRate: 0.20, totalWithRejects: 10 },
      { domain: "c.com", trustRate: 0.05, totalWithRejects: 10 },
    ],
  });
  // Caller is expected to sort, but the formatter at minimum should preserve order.
  // (runDailyDigest sorts ascending by trustRate before passing in.)
  const aIdx = msg.indexOf("a.com");
  const bIdx = msg.indexOf("b.com");
  const cIdx = msg.indexOf("c.com");
  expect("formatter preserves caller-provided order (caller sorts ascending)",
         aIdx > 0 && bIdx > aIdx && cIdx > bIdx,
         { aIdx, bIdx, cIdx }, "a < b < c");
}

// ── Test 7: markdown-unsafe book titles get scrubbed ──────────
{
  const msg = buildDailyDigestMessage({
    reportDate:    "2026-05-05",
    activeUsers24h: 1,
    daily: {},
    topBooks: [{ book: "*book* with [brackets]", count: 5 }],
    failingSources: [],
  });
  expect("book title strips * _ ` [ ] (Markdown control chars)",
         !msg.includes("*book*") && !msg.includes("[brackets]"),
         msg.match(/\d\..+—/u)?.[0] || "no match", "stripped title");
}

// ── Test 8: integration markers ───────────────────────────────
{
  const ALERT  = fs.readFileSync("server/bot/alertWatcher.ts", "utf-8");
  const DIGEST = fs.readFileSync("server/bot/dailyDigest.ts",  "utf-8");
  expect("alertWatcher imports runDailyDigest",
         ALERT.includes('import { runDailyDigest } from "./dailyDigest.js"'),
         true, true);
  expect("alertWatcher calls runDailyDigest in runCheck",
         ALERT.includes("await runDailyDigest(bot)"),
         true, true);
  expect("alertWatcher daily-digest catch path logs (not crashes)",
         /runDailyDigest[\s\S]{0,200}\.catch/.test(ALERT),
         true, true);
  expect("dailyDigest uses SET-NX-EX lock with 23h TTL",
         /set\(LAST_DIGEST_KEY[\s\S]{0,80}"EX"[\s\S]{0,40}LOCK_TTL_SEC[\s\S]{0,20}"NX"/.test(DIGEST),
         true, true);
  expect("dailyDigest gated on cairoHourNumber === DAILY_DIGEST_HOUR_CAIRO",
         /cairoHourNumber\(now\)\s*!==\s*DAILY_DIGEST_HOUR_CAIRO/.test(DIGEST),
         true, true);
  expect("dailyDigest fetches active users via zcount user:lastSeen",
         DIGEST.includes('zcount("user:lastSeen"'),
         true, true);
  expect("dailyDigest reports on YESTERDAY (not today's partial stats)",
         DIGEST.includes("yesterdayCairoKey"),
         true, true);
  expect("dailyDigest opt-out via DAILY_DIGEST_DISABLED",
         DIGEST.includes("DAILY_DIGEST_DISABLED"),
         true, true);
}

console.log(`\n────────────────`);
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
