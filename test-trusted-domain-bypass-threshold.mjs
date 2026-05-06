// ════════════════════════════════════════════════════════════════
// AUDIT 2026-05-04 — BUG A: TRUSTED_PDF_DOMAINS bypass threshold
// ════════════════════════════════════════════════════════════════
//
// السياق: في `pdfValidator.ts` فرع TRUSTED_PDF_DOMAINS (وقفية،
// libgen، Hindawi، …) لما الـ Firecrawl `searchTitle` غير متاح —
// يقع على gate تاني: `urlFilenameRelevance(bookName, pdfUrl)`. لو
// النتيجة ≥ threshold → bypass الـ Mistral وقبول مباشر بـ score=1.
//
// قبل الإصلاح: threshold كان 0.15 hard-coded — نفس النمط اللي
// PR #90 صلحه على فرع FILENAME_TRUSTED_PDF_DOMAINS بـ 0.6. مثال:
//   query = "العقيدة الواسطية" (Ibn Taymiyyah)
//   url   = "dl.waqfeya.net/.../العقيدة-السفارينية.pdf" (al-Saffarini)
//   score = 0.5 ≥ 0.15  → bypass → كتاب خطأ
//
// بعد الإصلاح: threshold = 0.55 (من config.ts، قابل للتعديل عبر env).
//   - 2-word queries: لازم الكلمتين يتطابقوا (1.0)
//   - 3-word queries: لازم 2/3 على الأقل (0.67)
//   - cases المشكوك فيها (0.15-0.5) → fall-through إلى Mistral
//
// نختبر:
//   E1: bundle markers — الكود الجديد فعلاً منشور
//   E2: probes للمنطق نفسه (حيث `urlFilenameRelevance` deterministic)
//   E3: trigger cases (strong matches → bypass) و non-trigger guards
//       (weak matches → fall through)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { urlFilenameRelevance } from "./server/bot/text.ts";
import { TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD } from "./server/bot/config.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(name, cond, want, got) {
  if (cond) { console.log(`[PASS] ${name}`); pass++; }
  else      { console.log(`[FAIL] ${name} — want=${JSON.stringify(want)} got=${JSON.stringify(got)}`); fail++; }
}

// ── E1: config constant exposed and ≥ 0.55 ──────────────────────
console.log("=== E1: config constant present and tight ===");
check("TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD ≥ 0.55",
  TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD >= 0.55,
  ">= 0.55", TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD);

// Verify the call site in pdfValidator.ts uses the constant (not 0.15).
const validatorSrc = fs.readFileSync(
  path.join(__dirname, "server/bot/pdfValidator.ts"), "utf8",
);
check("pdfValidator.ts imports TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD",
  validatorSrc.includes("TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD"),
  true, validatorSrc.includes("TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD"));

check("pdfValidator.ts no longer hard-codes 0.15 in trusted-domain branch",
  !validatorSrc.includes("if (filenameScore < 0.15)"),
  "absent", validatorSrc.match(/if \(filenameScore < 0\.15\)/) ? "present" : "absent");

check("trusted_domain_filename_bypass counter incremented",
  validatorSrc.includes('tel:pdf:trusted_domain_filename_bypass'),
  true, validatorSrc.includes('tel:pdf:trusted_domain_filename_bypass'));

// ── E2: trigger cases (strong matches) — bypass should fire ─────
console.log("\n=== E2: STRONG matches (bypass fires) ===");

const E2_triggerCases = [
  // English exact slug — always bypasses
  {
    name: "English exact: 'atomic habits' → archive.org/atomic-habits-ar.pdf",
    book: "atomic habits",
    url:  "https://archive.org/download/atomic-habits-ar/atomic-habits-ar.pdf",
  },
  // Arabic exact slug
  {
    name: "Arabic exact: 'العادات الذرية' → /العادات-الذرية.pdf",
    book: "العادات الذرية",
    url:  "https://dl.waqfeya.net/files/العادات-الذرية.pdf",
  },
  // 3-word query, 3 matches
  {
    name: "3-word exact: 'كافكا على الشاطئ' → /kafka-on-the-shore.pdf (cross-lang miss; English slug)",
    book: "kafka on the shore",
    url:  "https://archive.org/download/kafka-on-the-shore/kafka-on-the-shore.pdf",
  },
];

for (const c of E2_triggerCases) {
  const score = urlFilenameRelevance(c.book, c.url);
  const willBypass = score >= TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD;
  check(`${c.name} — score=${score.toFixed(2)} ≥ ${TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD} → bypass`,
    willBypass, true, willBypass);
}

// ── E3: WRONG-BOOK guards (fall through to Mistral) ─────────────
console.log("\n=== E3: WRONG-BOOK guards (must FALL THROUGH) ===");

const E3_guardCases = [
  // The exact production case — single shared word, different book
  {
    name: "Wrong book: 'العقيدة الواسطية' vs '/العقيدة-السفارينية.pdf' must NOT bypass",
    book: "العقيدة الواسطية",
    url:  "https://dl.waqfeya.net/files/العقيدة-السفارينية.pdf",
  },
  // Same prefix word, different topics
  {
    name: "Wrong book: 'تاريخ الفلسفة' vs '/تاريخ-مصر.pdf' must NOT bypass",
    book: "تاريخ الفلسفة",
    url:  "https://archive.org/download/tarikh-misr/تاريخ-مصر.pdf",
  },
  // 3-word query, 1 match → 0.33 < 0.55
  {
    name: "Wrong book: 'الموجز في فن التفاوض' vs '/dalilkuwa.pdf' must NOT bypass (cross-lang slug)",
    book: "الموجز في فن التفاوض",
    url:  "https://archive.org/download/dalilkuwa/dalilkuwa-s2021-a.pdf",
  },
  // 4-word query, 1 match
  {
    name: "Wrong book: 4-word query, 1 match → must NOT bypass",
    book: "كتاب فن العلاقات الإنسانية",
    url:  "https://dl.waqfeya.net/files/كتاب-أخر.pdf",
  },
];

for (const c of E3_guardCases) {
  const score = urlFilenameRelevance(c.book, c.url);
  const willBypass = score >= TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD;
  check(`${c.name} — score=${score.toFixed(2)} < ${TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD}`,
    !willBypass, false, willBypass);
}

// ── E4: env override works ──────────────────────────────────────
console.log("\n=== E4: env override behaviour (sanity) ===");
// This is a behavioural assertion — we verify the constant is parseFloat'd
// from process.env.TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD when set.
// Direct re-import won't re-evaluate (ESM module caching); we just
// assert the source pattern is correct.
const configSrc = fs.readFileSync(
  path.join(__dirname, "server/bot/config.ts"), "utf8",
);
check("config.ts wires env override for TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD",
  configSrc.includes("process.env.TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD"),
  true, configSrc.includes("process.env.TRUSTED_DOMAIN_FILENAME_BYPASS_THRESHOLD"));

// ════════════════════════════════════════════════════════════════
console.log("");
console.log("=".repeat(60));
console.log(`${pass}/${pass + fail} probes passed`);
console.log("=".repeat(60));
if (fail > 0) process.exit(1);
process.exit(0);
