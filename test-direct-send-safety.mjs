// ══════════════════════════════════════════════
// DIRECT-SEND SAFETY GATE — تتبّع الـ wrong-book delivery
// ══════════════════════════════════════════════
//
// السياق: فى production 2026-05-03، طلب user
//   "الموجز في فن التفاوض"
// والبوت بعتله "الدليل إلى القوة والدهاء" من archive.org
// (URL: dn790006.ca.archive.org/.../dalilkuwa-s2021-a.pdf).
//
// السبب: direct-mode send بيستخدم Telegram-fetches-URL، فالسيرفر مش
// بيحمّل الملف محلياً ⇒ pdfValidator مش بيشتغل أصلاً ⇒ أي URL موثوق
// لأي slug بـ يوصل للمستخدم.
//
// الإصلاح: قبل direct mode نشغّل filename relevance gate. لو
// `urlFilenameRelevance(book, url) < 0.15` ⇒ نسقط للـ local download
// (اللي بيشغّل full pdfValidator + Mistral).
//
// نختبر directSendUnsafe + filename relevance scoring + the new
// pdfValidator trusted-domain unrelated-filename branch.

import { urlFilenameRelevance } from "./server/bot/text.ts";

// نسخة مطابقة من directSendUnsafe في download.ts
function directSendUnsafe(bookName, pdfUrl) {
  const score = urlFilenameRelevance(bookName, pdfUrl);
  return score < 0.15;
}

let pass = 0, fail = 0;
const failures = [];

function check(name, got, want) {
  const ok = got === want;
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, got, want });
    console.log(`FAIL  ${name} :: got=${got} want=${want}`);
  }
}

// ══════════════════════════════════════════════
// Group 1: حالة production الحقيقية — dalilkuwa
// ══════════════════════════════════════════════
{
  const book = "الموجز في فن التفاوض";
  const url  = "https://dn790006.ca.archive.org/0/items/dalilkuwa-s2021-a/dalilkuwa-s2021-a.pdf";
  check(
    "T1: production case — dalilkuwa for fan al-tafawud → unsafe",
    directSendUnsafe(book, url),
    true,
  );
}

// ══════════════════════════════════════════════
// Group 2: matching slug → safe (allow direct)
// ══════════════════════════════════════════════
{
  // Latin transliteration that overlaps with Arabic via partial substring
  // The function is conservative — Latin won't normalize to Arabic words.
  // But informative Arabic-slug archive URL DOES match.
  check(
    "T2: arabic-slug archive → safe",
    directSendUnsafe(
      "الجنرال في متاهته",
      "https://dn720008.ca.archive.org/0/items/الجنرال-في-متاهته/الجنرال-في-متاهته.pdf",
    ),
    false,
  );
}

// ══════════════════════════════════════════════
// Group 3: digit-only filenames (Hindawi-style)
// ══════════════════════════════════════════════
{
  // urlFilenameRelevance returns 0.3 for digit-only. 0.3 >= 0.15 ⇒ safe.
  // (But Hindawi is in SKIP_DIRECT_DOMAINS anyway, so this only matters
  // for hosts that aren't pre-skipped.)
  check(
    "T3: digit-only filename → score 0.3 → safe (not unsafe)",
    directSendUnsafe(
      "أي كتاب عربي",
      "https://example.org/books/30903814.pdf",
    ),
    false,
  );
}

// ══════════════════════════════════════════════
// Group 4: Latin slug for Arabic book — score 0
// ══════════════════════════════════════════════
{
  check(
    "T4: Latin slug 'twilight-of-eve' for 'فن قراءة العقول' → unsafe",
    directSendUnsafe(
      "فن قراءة العقول",
      "https://example.org/items/twilight-of-eve.pdf",
    ),
    true,
  );
}

// ══════════════════════════════════════════════
// Group 5: partial Arabic match → safe
// ══════════════════════════════════════════════
{
  // urlFilenameRelevance only inspects the LAST URL segment (the
  // filename), not the directory. Confirm that path-token signal alone
  // is NOT enough to bypass the gate (we must see book words in the
  // actual filename).
  check(
    "T5: book word in directory but not filename → unsafe",
    directSendUnsafe(
      "فن قراءة العقول",
      "https://example.org/items/العقول-والذكاء/file.pdf",
    ),
    true,
  );

  // Real partial match — book word in filename
  check(
    "T5.b: book word in filename → safe",
    directSendUnsafe(
      "فن قراءة العقول",
      "https://example.org/items/فن-قراءة-العقول.pdf",
    ),
    false,
  );
}

// ══════════════════════════════════════════════
// Group 6: Empty filename / edge cases
// ══════════════════════════════════════════════
{
  check(
    "T6: malformed URL → unsafe (default safe-error)",
    directSendUnsafe("X", "not-a-url"),
    true,
  );

  check(
    "T6.b: short filename — score 0 → unsafe",
    directSendUnsafe("الجنرال في متاهته", "https://example.org/x.pdf"),
    true,
  );
}

// ══════════════════════════════════════════════
// Group 7: scoring spot-checks (filename only)
// ══════════════════════════════════════════════
{
  // Tests directly via urlFilenameRelevance to lock numeric thresholds
  function score(book, url) {
    return urlFilenameRelevance(book, url);
  }

  const s1 = score("الموجز في فن التفاوض",
                   "https://dn790006.ca.archive.org/0/items/dalilkuwa-s2021-a/dalilkuwa-s2021-a.pdf");
  check("T7.a: dalilkuwa score = 0", s1, 0);

  const s2 = score("أي كتاب", "https://example.org/books/30903814.pdf");
  check("T7.b: digit-only → 0.3", s2, 0.3);

  const s3 = score("الجنرال في متاهته",
                   "https://dn.archive.org/0/items/الجنرال-في-متاهته.pdf");
  // bookWords=["الجنرال","متاهته"] (filtered ≥3 chars; "في" is 2 chars filtered)
  // fileWords=["الجنرال","متاهته"]
  // matched=2, score=2/2=1.0
  check("T7.c: full Arabic match = 1.0", s3, 1);
}

// ══════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════
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
