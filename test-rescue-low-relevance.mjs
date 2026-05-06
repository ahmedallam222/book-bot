// Test: rescue-low-relevance candidate augmentation + apologetic
// failure messages with reply_to_message_id wiring.
//
// Background: production failure for "في قلبي أنثى عبرية" (Khawla
// Hamdi, bestseller). Firecrawl returned 20 results; only 1 had a
// directly extractable PDF link — a junk scholar.archive.org wayback
// URL pointing to an English academic *paper about* the novel, not
// the novel itself. The other 19 included high-relevance ketabpedia
// / foulabook / noor-book download pages dropped by the existing
// fallback chain (which only uses downloadablePageFallbacks when
// validUrls AND uniquePdfs are both empty). Bot sent "لا أملك نتيجة
// موثوقة" for a book available everywhere.
//
// This test verifies:
//   1. urlFilenameRelevance scoring sanity (book vs URL vs title)
//   2. The augmentation block in bookRequest.ts is wired correctly
//   3. Apologetic flag prepends an apology line in failure messages
//   4. reply_to_message_id is added when userMessageId is defined
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;

let pass = 0, fail = 0;
function check(label, condition, expected, actual) {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  expected=${JSON.stringify(expected)}  actual=${JSON.stringify(actual)}`); }
}

// ── 1. urlFilenameRelevance — title-based fallback math ──
const { urlFilenameRelevance } = await import("./server/bot/text.ts");

{
  const book = "في قلبي أنثى عبرية";

  // The actual junk URL the bot picked in production
  const junkUrl = "https://scholar.archive.org/work/7vnwjoh6v5d77ek7mmf2eua7em/access/wayback/http:";
  const junkScore = urlFilenameRelevance(book, junkUrl);
  check("junk scholar.archive.org URL scores below 0.30", junkScore < 0.30, "<0.30", junkScore);

  // Trailing-slash URL — pathname.split("/").pop() returns "", so URL-based score is 0
  const ketabpediaUrl = "https://ketabpedia.com/تحميل/fi-qalbi-ontha-ebreya-pdf/";
  const urlOnlyScore = urlFilenameRelevance(book, ketabpediaUrl);
  check("trailing-slash URL scores 0 (regression of urlFilenameRelevance)", urlOnlyScore === 0, 0, urlOnlyScore);

  // Title-based fallback: synthesize a fake URL from the title
  const ketabpediaTitle = "تحميل رواية في قلبي أنثى عبرية PDF خولة حمدي - موقع كتاب بدي";
  const titleAsUrl = `https://x/${encodeURIComponent(ketabpediaTitle)}.pdf`;
  const titleScore = urlFilenameRelevance(book, titleAsUrl);
  check("ketabpedia title-based score >= 0.50 (passes RESCUE_FALLBACK_THRESHOLD)", titleScore >= 0.50, ">=0.50", titleScore);

  // Combined max() score should rescue the candidate
  const combined = Math.max(urlOnlyScore, titleScore);
  check("max(url, title) score for ketabpedia is high (>= 0.50)", combined >= 0.50, ">=0.50", combined);

  // PaaS-typical noor-book tag URL with title
  const noorTitle = "كتاب في قلبي أنثى عبرية - مكتبة نور";
  const noorTitleScore = urlFilenameRelevance(book, `https://x/${encodeURIComponent(noorTitle)}.pdf`);
  check("noor-book title score >= 0.50", noorTitleScore >= 0.50, ">=0.50", noorTitleScore);

  // Negative case: unrelated title shouldn't pass threshold
  const unrelatedTitle = "كتاب آخر مختلف تماماً";
  const unrelatedScore = urlFilenameRelevance(book, `https://x/${encodeURIComponent(unrelatedTitle)}.pdf`);
  check("unrelated title scores < 0.50 (no false-positive rescue)", unrelatedScore < 0.50, "<0.50", unrelatedScore);
}

// ── 2. Verify the augmentation block exists in bookRequest.ts ──
const bookReqSrc = await readFile(path.join(root, "server/bot/bookRequest.ts"), "utf-8");

const integrationMarkers = [
  ["RESCUE-LOW-RELEVANCE comment block",     /RESCUE-LOW-RELEVANCE/],
  ["RESCUE_BEST_PDF_THRESHOLD = 0.30",       /RESCUE_BEST_PDF_THRESHOLD\s*=\s*0\.30/],
  ["RESCUE_FALLBACK_THRESHOLD = 0.50",       /RESCUE_FALLBACK_THRESHOLD\s*=\s*0\.50/],
  ["RESCUE_MAX_FALLBACKS = 3",               /RESCUE_MAX_FALLBACKS\s*=\s*3/],
  ["scoreWithTitleFallback helper",          /scoreWithTitleFallback/],
  ["rescue_low_relevance log line",          /rescue_low_relevance/],
  ["redis counter tel:dl:rescue_augmented",  /tel:dl:rescue_augmented/],
];
for (const [label, re] of integrationMarkers) {
  check(label, re.test(bookReqSrc), "match", re.toString());
}

// ── 3. reply_to_message_id wiring at all 3 fail-message sites ──
const replyMatches = bookReqSrc.match(/reply_to_message_id:\s*(?:userMessageId|job\.userMessageId)/g);
check("reply_to_message_id wired at >=3 sites", (replyMatches?.length ?? 0) >= 3, ">=3", replyMatches?.length);

const allowSendingMatches = bookReqSrc.match(/allow_sending_without_reply:\s*true/g);
check("allow_sending_without_reply guard at >=3 sites", (allowSendingMatches?.length ?? 0) >= 3, ">=3", allowSendingMatches?.length);

// Spread-conditional pattern (only adds keys when userMessageId truthy)
check("uses spread-conditional pattern for reply_to_message_id",
  /\.\.\.\(\s*(?:userMessageId|job\.userMessageId)/.test(bookReqSrc),
  "match", "...(userMessageId");

// ── 4. Apologetic flag wiring ──
check("buildNoResultMessage takes apologetic param",
  /buildNoResultMessage\(\s*[\s\S]*?apologetic/.test(bookReqSrc),
  "apologetic param", "missing");

check("buildNoResultMessage call passes apologetic=true",
  /buildNoResultMessage\(bookName,\s*\/\*\s*apologetic\s*\*\/\s*true/.test(bookReqSrc),
  "apologetic=true call", "missing");

check("buildPaidBookMessage call passes apologetic=true",
  /buildPaidBookMessage\(bookName,\s*\/\*\s*apologetic\s*\*\/\s*true/.test(bookReqSrc),
  "apologetic=true call", "missing");

check("buildNoResults call passes apologetic=true",
  /buildNoResults\(bookName,\s*false,\s*\/\*\s*apologetic\s*\*\/\s*true/.test(bookReqSrc),
  "apologetic=true call", "missing");

// ── 5. ui.ts message format ──
const uiSrc = await readFile(path.join(root, "server/bot/ui.ts"), "utf-8");

check("ui.ts buildNoResults takes apologetic param",
  /export function buildNoResults\(\s*bookName: string,\s*_usedFuzzy: boolean,\s*apologetic\s*=\s*false/.test(uiSrc),
  "signature", "missing");

check("ui.ts buildPaidBookMessage takes apologetic param",
  /export function buildPaidBookMessage\(\s*bookName: string,\s*apologetic\s*=\s*false/.test(uiSrc),
  "signature", "missing");

check("ui.ts apology has 🙏 + Arabic 'عذراً'",
  /🙏[^`]*عذراً/.test(uiSrc),
  "🙏...عذراً", "missing");

// ── 6. urlSearchTitle is reachable from rescue block ──
// The rescue block uses urlSearchTitle which is declared earlier in the
// same function — sanity check that we didn't accidentally move it.
const declMatch = bookReqSrc.match(/const urlSearchTitle = new Map<string, string>\(\)/);
check("urlSearchTitle Map declared", !!declMatch, "match", declMatch?.[0]);

const declIdx = bookReqSrc.indexOf("const urlSearchTitle = new Map");
const useIdx  = bookReqSrc.indexOf("urlSearchTitle.get(u)");
check("urlSearchTitle declared before rescue use", declIdx > 0 && useIdx > declIdx, "decl before use", { declIdx, useIdx });

// ── 7. Existing call sites with old signature still compile ──
// callbacks.ts uses buildPaidBookMessage(bookName) — the apologetic
// param defaults to false, so this should still work without change.
const cbSrc = await readFile(path.join(root, "server/bot/callbacks.ts"), "utf-8");
check("callbacks.ts buildPaidBookMessage(bookName) still compiles (default apologetic=false)",
  /buildPaidBookMessage\(bookName\)/.test(cbSrc),
  "default-arg call", "missing");

// ── Summary ──
console.log(`\nTotal: ${pass + fail}  pass=${pass}  fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
