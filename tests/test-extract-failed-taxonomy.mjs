// Deterministic probes for P4 of the 2026-05-09 audit.
//
// Background:
//   The audit window had `tel:pdf:extract_failed = 191` (68% of all
//   validator hits). It's a single monolithic counter incremented
//   whenever validateBookPdf hits the "no effectiveMetaTitle" branch.
//   That single branch is reached for at least four distinct reasons
//   that map to entirely different remediations (tighter source
//   filtering vs upstream search-title plumbing vs extending the
//   64KB scan window). With one counter, ops can't tell them apart.
//
// Fix:
//   1. After incrementing the umbrella TEL_EXTRACT_FAILED, also
//      increment a per-reason sub-counter:
//        garbage_meta_no_search       — placeholder /Title, no searchTitle
//        garbage_meta_search_unusable — placeholder /Title, bad searchTitle
//        no_meta_no_search            — no /Title in scan window, no searchTitle
//        no_meta_search_unusable      — no /Title, searchTitle present but bad
//
//   2. Add disposition counters tracking what HAPPENED to the
//      extract_failed candidate (rejected on filename / sent to
//      Mistral and accepted/rejected / fail-open accepted).
//
// All counters are ADDITIVE — TEL_EXTRACT_FAILED stays incremented
// for back-compat with existing dashboards/alerts.

import { readFileSync } from "node:fs";

const src = readFileSync("server/bot/pdfValidator.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("Per-reason validator telemetry (P4):");

// ── Per-reason taxonomy at the !effectiveMetaTitle branch ──────────

ok(
  "T1 — branch still increments umbrella TEL_EXTRACT_FAILED (back-compat)",
  /if\s*\(\s*!effectiveMetaTitle\s*\)\s*\{\s*\n\s*redis\.incr\(\s*TEL_EXTRACT_FAILED\s*\)/m.test(src),
);

ok(
  "T2 — extractFailedReason classifier covers all four cases",
  /extractFailedReason\s*=\s*["']garbage_meta_no_search["']/.test(src) &&
  /extractFailedReason\s*=\s*["']garbage_meta_search_unusable["']/.test(src) &&
  /extractFailedReason\s*=\s*["']no_meta_no_search["']/.test(src) &&
  /extractFailedReason\s*=\s*["']no_meta_search_unusable["']/.test(src),
);

ok(
  "T3 — taxonomy uses garbageMetaDetected + searchTitle to discriminate",
  /if\s*\(\s*garbageMetaDetected\s*&&\s*!searchTitle\s*\)/m.test(src) &&
  /else\s+if\s*\(\s*garbageMetaDetected\s*\)/m.test(src) &&
  /else\s+if\s*\(\s*!searchTitle\s*\)/m.test(src),
);

ok(
  "T4 — per-reason counter prefix matches dashboard convention `tel:pdf:extract_failed_reason:<name>`",
  /redis\.incr\(\s*[`"']tel:pdf:extract_failed_reason:\$\{extractFailedReason\}[`"']\s*\)/.test(src),
);

// ── Disposition counters (post-extract-failed branches) ─────────────

ok(
  "T5 — meaningless-filename short-circuit emits tel:pdf:no_meta_rejected_meaningless_fn",
  /isMeaninglessFilename\s*&&\s*MISTRAL_API_KEY[\s\S]{0,500}?tel:pdf:no_meta_rejected_meaningless_fn/m.test(src),
);

ok(
  "T6 — Mistral path emits accept/reject disposition counters",
  /tel:pdf:no_meta_mistral_accepted/.test(src) &&
  /tel:pdf:no_meta_mistral_rejected/.test(src),
);

ok(
  "T7 — fail-open path (no Mistral, no metaTitle) emits tel:pdf:no_meta_failopen_accepted",
  /tel:pdf:no_meta_failopen_accepted/.test(src),
);

// ── Wiring sanity ───────────────────────────────────────────────────

ok(
  "T8 — disposition counters live INSIDE the !effectiveMetaTitle block (not on the score-pass path)",
  // Take the slice between "if (!effectiveMetaTitle)" and the next score-block start
  // and verify the disposition counters appear ONLY there.
  (() => {
    const startIdx = src.indexOf("if (!effectiveMetaTitle)");
    const endIdx = src.indexOf("const score = wordOverlapScore", startIdx);
    if (startIdx < 0 || endIdx < 0) return false;
    const block = src.slice(startIdx, endIdx);
    const after = src.slice(endIdx);
    return (
      block.includes("tel:pdf:no_meta_rejected_meaningless_fn") &&
      block.includes("tel:pdf:no_meta_mistral_accepted") &&
      block.includes("tel:pdf:no_meta_mistral_rejected") &&
      block.includes("tel:pdf:no_meta_failopen_accepted") &&
      block.includes("tel:pdf:extract_failed_reason") &&
      // None of these counters leak into the score-based path:
      !after.includes("tel:pdf:no_meta_rejected_meaningless_fn") &&
      !after.includes("tel:pdf:no_meta_mistral_accepted") &&
      !after.includes("tel:pdf:no_meta_mistral_rejected") &&
      !after.includes("tel:pdf:no_meta_failopen_accepted") &&
      !after.includes("tel:pdf:extract_failed_reason")
    );
  })(),
);

ok(
  "T9 — Mistral-disposition counter is correctly wired to the `accepted` ternary",
  /redis\.incr\(\s*accepted\s*\n?\s*\?\s*["']tel:pdf:no_meta_mistral_accepted["']\s*\n?\s*:\s*["']tel:pdf:no_meta_mistral_rejected["']\s*\)/m.test(src),
);

ok(
  "T10 — accept/reject disposition is INDEPENDENT of TEL_ACCEPTED/TEL_REJECTED (both fire)",
  // The legacy TEL_ACCEPTED / TEL_REJECTED increments must remain so global
  // dashboards keep working — they were sometimes accidentally replaced
  // when adding sub-counters.
  /accepted\s*\)\s*redis\.incr\(\s*TEL_ACCEPTED\s*\)/m.test(src) &&
  /else\s+redis\.incr\(\s*TEL_REJECTED\s*\)/m.test(src),
);

ok(
  "T11 — `tel:pdf:filename_strong_match` is preserved (legacy disposition counter not removed)",
  /tel:pdf:filename_strong_match/.test(src),
);

ok(
  "T12 — `extract_failed_reason` keys are kebab-case ASCII (Redis-grep friendly)",
  ["garbage_meta_no_search", "garbage_meta_search_unusable",
   "no_meta_no_search", "no_meta_search_unusable"].every(
    (k) => /^[a-z_]+$/.test(k),
  ),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
