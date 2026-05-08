// ══════════════════════════════════════════════
// RELIABILITY PACK — guards for the 2026-05-08 fix
// ══════════════════════════════════════════════
//
// Production audit on 2026-05-08 showed delivery rate at 21% (5/24
// over the trailing 24h). Three contributing factors were addressed
// in this pack:
//
//   RC-1  per-domain download cap of 2 was abandoning healthy
//         sources after 2 failed candidate URLs. Bumped to 4 (and
//         the global cap from 6 → 8 in proportion).
//   RC-5a SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS = 5 left newly-bad
//         sources active on the typical 0/3 failure pattern.
//         Tightened to 3.
//   RC-5b dn790006.ca.archive.org and x2.books-library.net
//         were burning download attempts; added to UNRELIABLE_DOMAINS
//         seed so the soft penalty kicks in immediately on cold start.
//
// This test pins the values so silent regressions (e.g., someone
// reverting one constant during a future tune) are caught at PR time.
//
// We import from the compiled .ts directly via tsx — keep the runner
// invocation aligned with `tests/test-npm-test-runner.mjs` (npx tsx).

import {
  MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST,
  MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN,
  SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS,
  SOURCE_AUTO_DISABLE_HARD_MAX_RATE,
  UNRELIABLE_DOMAINS,
} from "../server/bot/config.ts";
import { buildLinksOnly } from "../server/bot/ui.ts";

let pass = 0, fail = 0;
const failures = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, got, want });
    console.log(`FAIL  ${name} :: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  }
}

// ── RC-1: download caps ───────────────────────
{
  check(
    "RC-1: per-domain cap default = 4 (was 2)",
    MAX_DOWNLOAD_ATTEMPTS_PER_DOMAIN,
    4,
  );
  check(
    "RC-1: per-request cap default = 8 (was 6)",
    MAX_DOWNLOAD_ATTEMPTS_PER_REQUEST,
    8,
  );
}

// ── RC-5a: tightened HARD auto-disable threshold ─────
{
  check(
    "RC-5a: HARD min attempts default = 3 (was 5)",
    SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS,
    3,
  );
  check(
    "RC-5a: HARD max rate stays 0% (catastrophic only)",
    SOURCE_AUTO_DISABLE_HARD_MAX_RATE,
    0.0,
  );
}

// Replays the auto-disable predicate from analytics.ts so we can
// assert that a 0/3 source flips to disabled with the new threshold
// but a 0/2 source does NOT (avoids over-aggressive disable on a
// single bad batch).
function hardAutoDisabled(ok, fail) {
  const total = ok + fail;
  const successRate = total > 0 ? ok / total : 0;
  return total >= SOURCE_AUTO_DISABLE_HARD_MIN_ATTEMPTS &&
         successRate <= SOURCE_AUTO_DISABLE_HARD_MAX_RATE;
}
{
  check("RC-5a: 0/3 catastrophic → disabled",  hardAutoDisabled(0, 3), true);
  check("RC-5a: 0/2 catastrophic → still active (need 3 samples)",
        hardAutoDisabled(0, 2), false);
  check("RC-5a: 1/3 (33% rate) → still active (rate above 0%)",
        hardAutoDisabled(1, 2), false);
  check("RC-5a: 0/10 → still disabled (regression guard)",
        hardAutoDisabled(0, 10), true);
}

// ── RC-5b: UNRELIABLE_DOMAINS seed additions ─────────
{
  // Seed entries (no env-var override). Substring match is enough —
  // sanitizeDomainKey lower-cases and the list is checked via
  // `.some(d => domain.includes(d))` in scoreUrl.
  check(
    "RC-5b: x2.books-library.net is seeded",
    UNRELIABLE_DOMAINS.includes("x2.books-library.net"),
    true,
  );
  check(
    "RC-5b: dn790006.ca.archive.org is seeded",
    UNRELIABLE_DOMAINS.includes("dn790006.ca.archive.org"),
    true,
  );
  // dn790009 (the older bad mirror) must remain seeded — guards
  // against an accidental delete during the tune.
  check(
    "RC-5b: dn790009.ca.archive.org seed preserved",
    UNRELIABLE_DOMAINS.includes("dn790009.ca.archive.org"),
    true,
  );
}

// ── UX: buildLinksOnly produces the expected fallback message ──
{
  const links = [
    "https://example.org/a/book.pdf",
    "https://other.example/b.pdf",
  ];
  const msg = buildLinksOnly("اسم الكتاب", links);
  check(
    "buildLinksOnly: includes apology header",
    msg.includes("لم أتمكّن من تحميل الكتاب"),
    true,
  );
  check(
    "buildLinksOnly: includes book name (escaped)",
    msg.includes("اسم الكتاب"),
    true,
  );
  check(
    "buildLinksOnly: includes both URLs",
    msg.includes("example.org/a/book") && msg.includes("other.example/b"),
    true,
  );
  // Caps to top-3 when more are passed.
  const long = [
    "https://a.example/1.pdf",
    "https://b.example/2.pdf",
    "https://c.example/3.pdf",
    "https://d.example/4.pdf",
    "https://e.example/5.pdf",
  ];
  const msg2 = buildLinksOnly("k", long);
  check(
    "buildLinksOnly: trims to first 3 links",
    msg2.includes("a.example/1") &&
      msg2.includes("b.example/2") &&
      msg2.includes("c.example/3") &&
      !msg2.includes("d.example/4") &&
      !msg2.includes("e.example/5"),
    true,
  );
  // Defensive empty-list fallback — must not produce a malformed message
  // (no empty list block); should fall through to the regular "no
  // results" content (looking for "لم أجد"/apology marker).
  const msg3 = buildLinksOnly("k", []);
  check(
    "buildLinksOnly: empty list falls back gracefully (non-empty)",
    typeof msg3 === "string" && msg3.length > 20,
    true,
  );
}

// ── Summary ────────────────────────────────────
console.log("");
console.log("=".repeat(60));
console.log(`RESULTS: ${pass} PASS, ${fail} FAIL  (total ${pass + fail})`);
console.log("=".repeat(60));
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(` - ${f.name}: got=${JSON.stringify(f.got)} want=${JSON.stringify(f.want)}`);
  }
  process.exit(1);
}
process.exit(0);
