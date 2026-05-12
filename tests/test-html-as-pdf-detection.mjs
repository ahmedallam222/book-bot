// Deterministic probes for P3 of the 2026-05-09 audit.
//
// Background:
//   The download path had a 2-tier flow:
//     1. Direct-send Telegram path → runs preValidatePdfUrl
//        (Range:bytes=0-4 GET, strict %PDF- prefix check).
//     2. Local download streaming path → NO pre-check; streams the
//        full body to disk, then runs a permissive
//        `magic.includes("%PDF")` over the first 10 bytes.
//
//   This caused two classes of waste:
//     a. Mislabelled-CT HTML interstitials served with
//        `Content-Type: application/pdf` — the streaming path wrote
//        the entire HTML body to temp before noticing.
//     b. PDFs with leading BOM/whitespace before the %PDF- header —
//        the permissive `includes` accepted them at download but the
//        validator rejected them at extract time, counted as the
//        opaque `tel:pdf:extract_failed` (191 hits in the audit
//        window, 68% of validator load).
//
// Fix:
//   1. Add preValidatePdfUrl call before local download streaming
//      (skipped when direct-send already ran it on the same URL).
//   2. Tighten the post-stream check from `magic.includes("%PDF")`
//      to strict `magic.subarray(0, 5).toString("ascii") === "%PDF-"`.
//   3. Per-failure-mode telemetry counters distinguishing pre-stream
//      preValidate rejects vs post-stream strict rejects, AND HTML
//      body vs other binary mismatch.
//
// Counters added:
//   tel:dl:prevalidate_html_rejected         — preValidate caught HTML
//   tel:dl:prevalidate_bad_magic_rejected    — preValidate caught other non-PDF
//   tel:dl:local_prevalidate_rejected        — local-path preValidate fired
//   tel:dl:post_stream_html_rejected         — strict post-stream caught HTML
//   tel:dl:post_stream_bad_magic_rejected    — strict post-stream caught non-PDF
//
// Naming: matches the project-standard `tel:dl:*` prefix used by all
// other download-related telemetry (see bookRequest.ts, download.ts:568).

import { readFileSync } from "node:fs";

const downloadSrc = readFileSync("server/bot/download.ts", "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}`); }

console.log("HTML-as-PDF detection (P3):");

// ── Tightened strict post-stream magic check ────────────────────────

ok(
  "T1 — post-stream check uses strict subarray(0,5) === '%PDF-' (no permissive `includes`)",
  /magic\.subarray\(\s*0\s*,\s*5\s*\)\.toString\(\s*["']ascii["']\s*\)/.test(downloadSrc) &&
  !/magic\.includes\(\s*Buffer\.from\(\s*["']%PDF["']\s*\)\s*\)/.test(downloadSrc),
);

ok(
  "T2 — post-stream check classifies HTML body separately from binary mismatch",
  /post_stream_html_rejected/.test(downloadSrc) &&
  /post_stream_bad_magic_rejected/.test(downloadSrc) &&
  /<!doc|<html|<\?xml/i.test(downloadSrc),
);

// ── New: local-path preValidate gate ────────────────────────────────

ok(
  "T3 — local download streaming is gated by preValidatePdfUrl when direct-send didn't already run it",
  /directWasPreValidated/.test(downloadSrc) &&
  /preValidatePdfUrl\(pdfUrl\)/.test(downloadSrc),
);

ok(
  "T4 — local-path preValidate failure increments tel:dl:local_prevalidate_rejected",
  /tel:dl:local_prevalidate_rejected/.test(downloadSrc),
);

ok(
  "T5 — local-path preValidate failure returns { ok: false, permanent: true } (mirrors direct path)",
  /preValidate \(local path\)[\s\S]{0,500}?return\s*\{\s*ok:\s*false,\s*permanent:\s*true\s*\}/m.test(downloadSrc),
);

ok(
  "T6 — gate skips re-running preValidate when direct-send already ran it (avoid double Range request)",
  /directWasPreValidated\s*=\s*!shouldSkipDirect[\s\S]{0,200}?if\s*\(\s*!directWasPreValidated\s*\)/m.test(downloadSrc),
);

// ── Existing preValidatePdfUrl now has per-reason telemetry ─────────

ok(
  "T7 — preValidatePdfUrl labels HTML responses (`<!doc`, `<html`, `<?xml`) separately",
  /prevalidate_html_rejected/.test(downloadSrc) &&
  /prevalidate_bad_magic_rejected/.test(downloadSrc),
);

ok(
  "T8 — preValidate strict %PDF- prefix check still in place (regression guard)",
  /buf\.slice\(\s*0\s*,\s*5\s*\)\.toString\(\s*["']ascii["']\s*\)\s*!==?\s*["']%PDF-["']/.test(downloadSrc),
);

// ── Sanity: no permissive .includes("%PDF") sneaks back in ──────────

ok(
  "T9 — no occurrence of permissive `magic.includes(\"%PDF\")` in the file",
  !/magic\.includes\(\s*Buffer\.from\(\s*["']%PDF["']\s*\)\s*\)/.test(downloadSrc) &&
  !/magic\.includes\(\s*["']%PDF["']\s*\)/.test(downloadSrc),
);

ok(
  "T10 — strict prefix check positioned AFTER the temp-file size check (so we don't double-fail empty files)",
  /temp file too small or missing[\s\S]{0,2000}?magicHead\s*=\s*magic\.subarray/m.test(downloadSrc),
);

ok(
  "T11 — counters use project-standard tel:dl:* prefix (regression for code review on #136)",
  // Every download-related telemetry counter in the project uses the
  // tel:dl: prefix. The original P3 commit accidentally introduced
  // tel:download: which broke ops dashboards filtering on tel:dl:*.
  !/tel:download:/.test(downloadSrc) &&
  /tel:dl:prevalidate_html_rejected/.test(downloadSrc) &&
  /tel:dl:prevalidate_bad_magic_rejected/.test(downloadSrc) &&
  /tel:dl:local_prevalidate_rejected/.test(downloadSrc) &&
  /tel:dl:post_stream_html_rejected/.test(downloadSrc) &&
  /tel:dl:post_stream_bad_magic_rejected/.test(downloadSrc),
);

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
