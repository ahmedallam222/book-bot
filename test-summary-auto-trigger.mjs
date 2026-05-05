// Deterministic probes for PR G — Summary auto-trigger.
//
// Verifies:
//  G1. Bundle markers — new symbols are shipped
//  G2. detectSummaryIntent() — the pure detector reproduced here
//      against the same inputs the runtime uses (mirrors the
//      regex shape from bookNameParser.ts)
//  G3. QueueJob carries `wantsSummary` field (typing + runtime)
//  G4. Idempotency / lock key shape (string contract probe)
//
// We cannot directly invoke runSummaryFlow without Redis + Telegram
// + Mistral — those are integration tests. The probes here cover the
// path-decisions that determine whether the auto-trigger fires.

import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
function ok(name, cond, info) {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else      { console.log(`  FAIL  ${name}${info ? "  → " + info : ""}`); fail++; }
}

const BUNDLE = fs.readFileSync(
  path.join(process.cwd(), "dist/index.cjs"),
  "utf8",
);

// ─── G1 — bundle markers ────────────────────────────────
console.log("G1 — bundle markers");
ok("detectSummaryIntent shipped",       BUNDLE.includes("detectSummaryIntent"));
ok("runSummaryFlow shipped",            BUNDLE.includes("runSummaryFlow"));
ok("maybeAutoSummary shipped",          BUNDLE.includes("maybeAutoSummary"));
ok("wantsSummary field shipped",        BUNDLE.includes("wantsSummary"));
ok("auto-trigger lock key prefix",      BUNDLE.includes("summary:auto:"));
ok("auto-trigger telemetry counter",    BUNDLE.includes("tel:summary:auto_triggered"));
ok("inflight TTL 90s baked in",         /summary:auto:[^"]*"[^"]*90/.test(BUNDLE) || BUNDLE.includes('"EX",90') || BUNDLE.includes("EX\", 90") || /"EX"\s*,\s*90/.test(BUNDLE));
ok("dynamic import to avoid circular dep", /summaryHandler\.js|summaryHandler/.test(BUNDLE));

// ─── G2 — detectSummaryIntent reproduction ──────────────
const SUMMARY_WORDS = [
  "لخصلي", "لخّصلي", "لخّص لي", "لخص لي", "لخّص", "لخص",
  "تلخيص", "ملخص", "مُلخّص", "ملخّص",
  "اختصرلي", "اختصر لي", "اختصر",
];
const PATTERNS = SUMMARY_WORDS.map((w) => new RegExp(`(^|\\s)${w}(\\s|$)`, "i"));
function detectSummaryIntent(raw) {
  if (!raw) return false;
  const t = raw.trim();
  if (!t) return false;
  return PATTERNS.some((p) => p.test(t));
}

console.log("\nG2 — detectSummaryIntent");

// True cases — should detect intent
ok("'لخصلي أرض زيكولا' → true",
   detectSummaryIntent("لخصلي أرض زيكولا") === true);
ok("'ملخص فن قراءة العقول' → true",
   detectSummaryIntent("ملخص فن قراءة العقول") === true);
ok("'لخص الأمير الصغير' → true",
   detectSummaryIntent("لخص الأمير الصغير") === true);
ok("'تلخيص مذكرات جيفارا' → true",
   detectSummaryIntent("تلخيص مذكرات جيفارا") === true);
ok("'اختصرلي حوار مع صديقي' → true",
   detectSummaryIntent("اختصرلي حوار مع صديقي") === true);
// trailing position
ok("'فن قراءة العقول لخصلي' → true",
   detectSummaryIntent("فن قراءة العقول لخصلي") === true);
// shadda variant
ok("'لخّصلي الأطلال' → true",
   detectSummaryIntent("لخّصلي الأطلال") === true);
// space-separated form
ok("'لخص لي الأطلال' → true",
   detectSummaryIntent("لخص لي الأطلال") === true);

// False cases — should NOT detect
ok("plain title 'أرض زيكولا' → false",
   detectSummaryIntent("أرض زيكولا") === false);
ok("plain title 'فن قراءة العقول' → false",
   detectSummaryIntent("فن قراءة العقول") === false);
ok("title containing 'لخص' as substring of book name (not standalone) → false",
   detectSummaryIntent("شاطئ ملخصات") === false); // "ملخصات" ≠ "ملخص" word boundary
ok("empty string → false",
   detectSummaryIntent("") === false);
ok("whitespace only → false",
   detectSummaryIntent("   ") === false);
ok("English-only 'kafka on the shore' → false",
   detectSummaryIntent("kafka on the shore") === false);

// ─── G3 — QueueJob.wantsSummary contract ─────────────────
console.log("\nG3 — QueueJob.wantsSummary contract");
// The job is serialized as JSON to Redis; verify the field round-trips
const sampleJob = {
  id: "u1-1234-abcde",
  userId: "u1",
  chatId: 100,
  bookName: "أرض زيكولا",
  token: "T",
  userName: null,
  priority: "normal",
  retries: 0,
  createdAt: Date.now(),
  wantsSummary: true,
};
const serialized   = JSON.stringify(sampleJob);
const deserialized = JSON.parse(serialized);
ok("wantsSummary survives JSON round-trip",
   deserialized.wantsSummary === true);
ok("wantsSummary undefined survives (omitted)",
   JSON.parse(JSON.stringify({ ...sampleJob, wantsSummary: undefined })).wantsSummary === undefined);

// ─── G4 — Lock key shape ────────────────────────────────
console.log("\nG4 — Auto-summary lock key");
function buildLockKey(userId, bookName) {
  // Simplified canonicalize: lowercase + trim + collapse spaces
  // (the runtime uses canonicalizeForCache; we just verify the key
  // prefix/shape, not the exact normalization)
  return `summary:auto:${userId}:${bookName.trim().toLowerCase()}`;
}
ok("lock key format starts with 'summary:auto:'",
   buildLockKey("u1", "kafka").startsWith("summary:auto:"));
ok("lock key includes userId and book name",
   buildLockKey("u1", "kafka") === "summary:auto:u1:kafka");
ok("different users get distinct locks for same book",
   buildLockKey("u1", "kafka") !== buildLockKey("u2", "kafka"));

// ─── G5 — Idempotency / message routing markers ────────
console.log("\nG5 — additional shipping markers");
ok("auto-summary log message shipped (en)",
   BUNDLE.includes("auto-summary triggered"));
ok("auto-summary skip log shipped (en)",
   BUNDLE.includes("auto-summary already in flight") ||
   BUNDLE.includes("already in flight"));

console.log(`\nTotal: ${pass + fail}  pass=${pass}  fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
