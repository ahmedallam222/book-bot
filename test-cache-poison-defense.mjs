// Deterministic probes for PR #33 (cache-poison defense).
//
// Production audit on 2026-05-03 found 10 cache entries poisoned with
// wrong Hindawi PDFs. Root cause: PR #31's title-gate only fires when
// the search-result HTML title is non-empty. When Firecrawl returned
// no title (or just a URL fallback) for an opaque Hindawi `/books/<id>.pdf`
// URL, the trusted-domain bypass accepted blindly. The file got delivered
// AND cached — every subsequent request for that book name served the
// same wrong PDF straight from cache, no re-validation.
//
// We test:
//   D1 — `hasUninformativeFilename(url)` correctly identifies digit-only
//        filenames as opaque (Hindawi-class), and informative filenames
//        as safe.
//   D2 — `bookRequest.ts` cache-write guard refuses to persist file_ids
//        when the source URL is opaque (defense-in-depth even if the
//        validator's bypass logic regresses).
//
// We import nothing from the real bot code (it pulls Redis/PG at module
// load). Instead we replicate `hasUninformativeFilename` literally — a
// 6-line pure function with no deps. `tsc --noEmit` separately verifies
// the production export signature.

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

// Verbatim copy of pdfValidator.ts:36-45.
// If you change one, change the other.
function hasUninformativeFilename(u) {
  try {
    const filename = decodeURIComponent(
      new URL(u).pathname.split("/").pop()?.split("?")[0] || ""
    ).replace(/\.pdf$/i, "").trim();
    return filename.length > 0 && /^\d+$/.test(filename);
  } catch {
    return false;
  }
}

// ── D1: hasUninformativeFilename ────────────────
console.log("=== D1: hasUninformativeFilename ===");

const helperCases = [
  // Digit-only Hindawi-style URLs — opaque (true).
  ["https://downloads.hindawi.org/books/14168605.pdf", true],
  ["https://downloads.hindawi.org/books/62575295.pdf", true],
  ["https://example.com/files/0123456789.pdf", true],
  // Mixed alpha+digit, slug-style — informative (false).
  ["https://archive.org/download/abc-book/abc.pdf", false],
  ["https://bookleaks.com/the-one-thing.pdf", false],
  ["https://example.com/books/Naguib-Mahfouz-1.pdf", false],
  // Edge: empty filename (last path segment empty).
  ["https://hindawi.org/", false],
  ["https://hindawi.org/books/", false],
  // Edge: not a URL.
  ["not a url", false],
  ["", false],
  // Edge: digit-only WITHOUT .pdf extension (still opaque — same risk).
  ["https://hindawi.org/books/12345", true],
  // Mixed pattern that's NOT pure digits — has a letter, informative.
  ["https://hindawi.org/books/12345-abc.pdf", false],
  // Query string after .pdf — should be stripped before the digit check.
  ["https://hindawi.org/books/14168605.pdf?ref=foo", true],
];

for (const [u, want] of helperCases) {
  const got = hasUninformativeFilename(u);
  check(`url='${u.slice(0, 60)}'`, got === want, want, got);
}

// ── D2: cache-write guard logic ─────────────────
//
// Replicate the boolean expression from bookRequest.ts:701:
//   if (sentFileId && !isSuspectFile && !opaqueUrl) cacheBook(...)
//
// PR #32 baseline (before fix):
//   if (sentFileId && !isSuspectFile) cacheBook(...)

console.log("=== D2: cache-write guard ===");

const guardCases = [
  // Real production scenarios (2026-05-03 audit findings):
  {
    name: "Hindawi opaque URL — was poisoning cache, now blocked",
    sentFileId: "BAQACAgIAxxx",
    sentFilenameScore: 0.3,           // digit-only → 0.3 from text.ts:110
    pdfUrl: "https://downloads.hindawi.org/books/14168605.pdf",
    expectedOpaque: true,
    expectedLegacyCache: true,         // was cached (bug)
    expectedFixedCache: false,         // now blocked
  },
  {
    name: "Hindawi single-digit edge — opaque",
    sentFileId: "BAQACAgIAyyy",
    sentFilenameScore: 0.3,
    pdfUrl: "https://downloads.hindawi.org/books/0.pdf",
    expectedOpaque: true,
    expectedLegacyCache: true,
    expectedFixedCache: false,
  },
  {
    name: "archive.org slug URL — informative, still cached",
    sentFileId: "BAQACAgIAzzz",
    sentFilenameScore: 0.85,
    pdfUrl: "https://archive.org/download/the-one-thing/The-ONE-Thing.pdf",
    expectedOpaque: false,
    expectedLegacyCache: true,
    expectedFixedCache: true,
  },
  {
    name: "Suspect file (low filename score) — both paths block",
    sentFileId: "BAQACAgIAaaa",
    sentFilenameScore: 0.02,           // < 0.05 → suspect
    pdfUrl: "https://example.com/totally-unrelated.pdf",
    expectedOpaque: false,
    expectedLegacyCache: false,
    expectedFixedCache: false,
  },
  {
    name: "No fileId — both paths block (sendDocument failed)",
    sentFileId: undefined,
    sentFilenameScore: 0.85,
    pdfUrl: "https://archive.org/download/foo/foo.pdf",
    expectedOpaque: false,
    expectedLegacyCache: false,
    expectedFixedCache: false,
  },
  {
    name: "bookleaks slug URL — informative, cached",
    sentFileId: "BAQACAgIAbbb",
    sentFilenameScore: 0.7,
    pdfUrl: "https://bookleaks.com/zoqaq-elmadaq.pdf",
    expectedOpaque: false,
    expectedLegacyCache: true,
    expectedFixedCache: true,
  },
];

for (const c of guardCases) {
  const isSuspect = c.sentFilenameScore < 0.05;
  const opaque   = hasUninformativeFilename(c.pdfUrl);
  const legacy   = !!c.sentFileId && !isSuspect;
  const fixed    = !!c.sentFileId && !isSuspect && !opaque;

  check(`${c.name} | opaque`,        opaque === c.expectedOpaque,        c.expectedOpaque,        opaque);
  check(`${c.name} | legacy-cache`,  legacy === c.expectedLegacyCache,  c.expectedLegacyCache,  legacy);
  check(`${c.name} | fixed-cache`,   fixed === c.expectedFixedCache,    c.expectedFixedCache,    fixed);
}

// ── D3: validator bypass behavior ───────────────
//
// We can't run the validator end-to-end without infra, but we can
// simulate the new branching logic from pdfValidator.ts:625-685
// to verify that opaque URLs without searchTitle now fall through
// (i.e. do NOT short-circuit accept).

console.log("=== D3: trusted-domain bypass logic ===");

function trustedBypassDecision({ pdfUrl, searchTitle }) {
  const hasTitle  = !!(searchTitle && !searchTitle.startsWith("http"));
  const hasOpaque = hasUninformativeFilename(pdfUrl);

  if (hasTitle) {
    // Title-gate runs (PR #31). We don't simulate the score here —
    // assume it passes. Returns "accepted_via_title".
    return "accepted_via_title";
  }
  if (hasOpaque) {
    // PR #33: fall through to full validation instead of bypassing.
    return "fall_through";
  }
  // Informative URL, no title — PR #31 behavior preserved.
  return "accepted_via_legacy_bypass";
}

const bypassCases = [
  {
    name: "Hindawi opaque URL, no title — falls through (was bypass bug)",
    pdfUrl: "https://downloads.hindawi.org/books/14168605.pdf",
    searchTitle: "",
    expected: "fall_through",
  },
  {
    name: "Hindawi opaque URL, with title — title-gate runs",
    pdfUrl: "https://downloads.hindawi.org/books/14168605.pdf",
    searchTitle: "تحت مسمى الرجولة - نوال السعداوي",
    expected: "accepted_via_title",
  },
  {
    name: "Hindawi opaque URL, URL-fallback title — falls through",
    pdfUrl: "https://downloads.hindawi.org/books/14168605.pdf",
    searchTitle: "https://downloads.hindawi.org/books/14168605.pdf",
    expected: "fall_through",
  },
  {
    name: "libgen informative URL, no title — legacy bypass preserved",
    pdfUrl: "https://libgen.is/get.php?md5=abc&book=hello-world.pdf",
    searchTitle: "",
    expected: "accepted_via_legacy_bypass",
  },
  {
    name: "trusted slug URL, no title — legacy bypass preserved",
    pdfUrl: "https://dl.waqfeya.net/books/the-quran.pdf",
    searchTitle: "",
    expected: "accepted_via_legacy_bypass",
  },
];

for (const c of bypassCases) {
  const got = trustedBypassDecision(c);
  check(c.name, got === c.expected, c.expected, got);
}

// ── Summary ────────────────────────────────────
console.log("");
console.log(`${pass}/${pass + fail} probes passed`);
if (fail > 0) process.exit(1);
