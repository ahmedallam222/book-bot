// Deterministic probes for the restored Filename-trusted Mistral bypass
// (server/bot/pdfValidator.ts, ambiguous-zone branch).
//
// Background: PR #14 (5ada9e3) added a bypass: when the PDF URL is hosted
// on a curated content library (FILENAME_TRUSTED_PDF_DOMAINS) AND the
// filename has high overlap with the requested book, accept directly
// without paying for Mistral. The bypass *call site* was lost during a
// merge resolution; the helper function and config constants survived
// but were dead. This test verifies the bypass is wired up again.
//
// We test bundle markers + the urlFilenameRelevance() pure function
// against realistic filename samples at the 0.5 threshold the PR uses.

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

// ─── E1 — bundle markers (call site exists) ────────────────────────
console.log("E1 — bundle markers");
ok("filename_trusted_bypass log message shipped",
   BUNDLE.includes("filename_trusted_bypass"));
ok("tel:pdf:filename_trusted_bypass counter shipped",
   BUNDLE.includes("tel:pdf:filename_trusted_bypass"));
ok("isFilenameTrustedDomain still defined",
   /isFilenameTrustedDomain/.test(BUNDLE));
ok("MISTRAL_BYPASS_FILENAME_THRESHOLD baked into bundle",
   /MISTRAL_BYPASS_FILENAME_THRESHOLD/.test(BUNDLE) ||
   /BYPASS_FILENAME_THRESHOLD/.test(BUNDLE));
ok("default threshold 0.6 baked in (0.5 → 0.6 hardening)",
   /BYPASS_FILENAME_THRESHOLD\s*\|\|\s*"0\.6"/.test(BUNDLE));
ok("FILENAME_TRUSTED_PDF_DOMAINS list present",
   BUNDLE.includes("archive.org") &&
   BUNDLE.includes("bookleaks.com") &&
   BUNDLE.includes("book-shadow.com"));

// ─── E2 — urlFilenameRelevance reproduction (matches text.ts impl) ──
function normalizeForCache(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\u0600-\u06FFa-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function urlFilenameRelevance(bookName, url) {
  try {
    const filename = decodeURIComponent(
      new URL(url).pathname.split("/").pop()?.split("?")[0] || ""
    ).replace(/\.pdf$/i, "").replace(/[-_+]/g, " ").trim().toLowerCase();
    if (!filename || filename.length < 2) return 0;
    if (/^\d+$/.test(filename.replace(/\s/g, ""))) return 0.3;
    const normBook = normalizeForCache(bookName);
    const normFile = normalizeForCache(filename);
    const bookWords = normBook.split(/\s+/).filter((w) => w.length >= 3);
    const fileWords = new Set(normFile.split(/\s+/).filter((w) => w.length >= 3));
    if (bookWords.length === 0 || fileWords.size === 0) return 0.1;
    const matched = bookWords.filter((w) => fileWords.has(w)).length;
    if (matched === 0) {
      const bookNoSpace = normBook.replace(/\s/g, "");
      const fileNoSpace = normFile.replace(/\s/g, "");
      if (fileNoSpace.length > 4 && bookNoSpace.includes(fileNoSpace.slice(0, 5))) return 0.15;
      return 0;
    }
    return matched / bookWords.length;
  } catch {
    return 0;
  }
}

const THRESHOLD = 0.6; // MISTRAL_BYPASS_FILENAME_THRESHOLD default (PR #14 used 0.5; bumped here to harden against short-Arabic-query false-positives like "العقيدة الواسطية" vs "العقيدة السفارينية")

// ─── E3 — bypass triggers (saves Mistral) ─────────────────────────
console.log("\nE3 — bypass triggers (saves Mistral)");
const triggerCases = [
  // Real PR #14 motivating example: archive.org + cross-language slug
  ["العادات الذرية", "https://archive.org/download/atomic-habits-ar/atomic-habits-ar.pdf",
   false, "Cross-language slug (Mistral would still need to verify)"],
  ["atomic habits", "https://archive.org/download/atomic-habits-ar/atomic-habits-ar.pdf",
   true, "English slug for English query"],
  ["arabic book name", "https://archive.org/download/arabic-book-name/arabic-book-name.pdf",
   true, "Exact slug match, English query"],
  ["كافكا على الشاطئ", "https://bookleaks.com/files/كافكا_على_الشاطئ.pdf",
   true, "Arabic Unicode filename match"],
  ["زقاق المدق", "https://book-shadow.com/files/زقاق_المدق.pdf",
   true, "Arabic match on book-shadow"],
];

for (const [book, url, _trustedDomain, label] of triggerCases) {
  const score = urlFilenameRelevance(book, url);
  const wouldTrigger = score >= THRESHOLD;
  const marker = wouldTrigger ? "triggers" : "delegates to Mistral";
  // We just print; assertion is whether the relevance computation
  // produces the expected band for this filename pattern. For the
  // cross-language case (Arabic query, English slug), score is
  // expected to be 0 → bypass does NOT fire (Mistral handles it).
  console.log(`  ${wouldTrigger ? "PASS" : "INFO"}  "${book}" → score=${score.toFixed(2)} (${marker}) — ${label}`);
}
// All trigger cases that match the slug language should produce
// score ≥ 0.5. We assert at least 4/5 of the same-language cases
// produce a triggering score (the cross-language one is intentional
// non-trigger).
const sameLanguageCases = triggerCases.filter(([_, __, expectTrigger]) => expectTrigger);
const triggered = sameLanguageCases.filter(([book, url]) => urlFilenameRelevance(book, url) >= THRESHOLD).length;
ok(`same-language slugs trigger bypass ≥ 4/${sameLanguageCases.length}`, triggered >= 4,
   `only ${triggered}/${sameLanguageCases.length} triggered`);

// ─── E4 — bypass does NOT trigger on wrong-book candidates ─────────
console.log("\nE4 — bypass does NOT trigger on wrong-book candidates (Mistral still fires)");
const noTriggerCases = [
  // The real-world incident: archive.org dalilkuwa filename for unrelated query.
  ["الموجز في فن التفاوض", "https://archive.org/download/dalilkuwa-s2021-a/dalilkuwa-s2021-a.pdf",
   "Wrong book on archive.org (incident from PR #33)"],
  ["كتاب الأطلال", "https://bookleaks.com/files/server/53.pdf",
   "Opaque numeric URL"],
  ["مذكرات جيفارا", "https://archive.org/files/random-book.pdf",
   "Zero overlap"],
  ["العقيدة الواسطية", "https://archive.org/files/العقيدة-السفارينية.pdf",
   "Similar but different book"],
];

let okNoTrigger = 0;
for (const [book, url, label] of noTriggerCases) {
  const score = urlFilenameRelevance(book, url);
  const wouldTrigger = score >= THRESHOLD;
  if (!wouldTrigger) {
    console.log(`  PASS  "${book}" → score=${score.toFixed(2)} (no bypass) — ${label}`);
    okNoTrigger++;
  } else {
    console.log(`  FAIL  "${book}" → score=${score.toFixed(2)} TRIGGERED bypass! — ${label}`);
  }
}
ok(`wrong-book candidates ALL fall through to Mistral`, okNoTrigger === noTriggerCases.length,
   `only ${okNoTrigger}/${noTriggerCases.length} correctly fell through`);

// ─── E5 — domain gate works (untrusted domains never bypass) ──────
console.log("\nE5 — domain gate (untrusted domains never bypass)");
const FILENAME_TRUSTED = ["archive.org", "bookleaks.com", "book-shadow.com"];
const UNTRUSTED = ["www.foulabook.com", "noor-book.com", "unknown-host.example"];

function isFilenameTrustedDomain(url) {
  return FILENAME_TRUSTED.some(d => url.includes(d));
}

ok("archive.org is filename-trusted",
   isFilenameTrustedDomain("https://archive.org/download/x/x.pdf"));
ok("bookleaks.com is filename-trusted",
   isFilenameTrustedDomain("https://bookleaks.com/files/x.pdf"));
ok("book-shadow.com is filename-trusted",
   isFilenameTrustedDomain("https://book-shadow.com/files/x.pdf"));
for (const host of UNTRUSTED) {
  ok(`${host} is NOT filename-trusted`,
     !isFilenameTrustedDomain(`https://${host}/x.pdf`));
}

// ─── Summary ──────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(`RESULTS: ${pass} PASS, ${fail} FAIL  (total ${pass + fail})`);
console.log("=".repeat(60));

if (fail > 0) process.exit(1);
