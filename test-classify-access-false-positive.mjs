// Regression test for FIX-PAID-FALSE-POSITIVE
// Verifies that the new PROTECTED_ACCESS_PATTERNS no longer fires on
// generic UI words like "premium", "subscribe", "price", "checkout"
// that appear in newsletter signup boxes, sidebar widgets, copyright
// footers — but DO fire on actual paid-book signals.

const PROTECTED_ACCESS_PATTERNS = [
  /(?:شراء|اشتري?(?:ه)?)\s+(?:الآن|الكتاب|المنتج|النسخة)|أضف(?:ه)?\s+(?:إلى|الى)\s+(?:السلة|عربة|عربتك)|اضف(?:ه)?\s+(?:إلى|الى)\s+(?:السلة|عربة|عربتك)|نفد(?:ت)?\s+(?:الكمية|المخزون)|غير\s+متوفر\s+مجان(?:اً|ا)?|متوفر\s+للبيع|للبيع\s+فقط|الدفع\s+(?:الإلكتروني|عبر|بـ)|أتمم?\s+(?:عملية\s+)?الشراء/i,
  /\b(?:buy\s+now|add\s+to\s+(?:cart|basket)|out\s+of\s+stock|sold\s+out|not\s+(?:available\s+)?for\s+free|proceed\s+to\s+checkout|complete\s+(?:your\s+)?purchase|paid\s+(?:only|content|version|access))\b/i,
  /[\$€£¥]\s?\d+(?:[.,]\d+)?(?!\s*(?:%|سنة|years?))|(?:^|[^\d.,])\d+(?:[.,]\d+)?\s*(?:USD|EUR|GBP|JPY|SAR|AED|EGP|KWD|QAR|BHD|OMR|JOD|ر\.?س\.?|ج\.?م\.?|د\.?ك\.?|د\.?\u0625\.?|ريال|دينار|درهم|جنيه|ليرة)(?=[\s.,;:،؛]|$)/i,
  /قراءة\s+فقط(?!\s+ل(?:جزء|بعض))|للاطلاع\s+فقط|لا\s+يسمح\s+ب?التحميل|غير\s+قابل\s+للتنزيل|read[\-\s]only\s+access|preview\s+only\s+\(?\s*\d+\s*pages?\s*\)?/i,
];

function countMatches(text) {
  let hits = 0;
  for (const p of PROTECTED_ACCESS_PATTERNS) {
    if (p.test(text)) hits++;
  }
  return hits;
}

const FREE_BOOK_PAGES = [
  // kutubm.com book page (free)
  {
    name: "kutubm.com — علمتني سورة البقرة (free)",
    text: `كتاب علمتني سورة البقرة - المؤلف علي بن حسين العلي - تصنيف كتب إسلامية - اللغة العربية - رابط التحميل`,
    expectMatches: 0,
  },
  // hindawi.org with copyright footer
  {
    name: "hindawi.org with copyright notice in footer",
    text: `كتاب الأيام - طه حسين - حقوق النشر محفوظة لمؤسسة هنداوي. تحميل PDF مجاناً.`,
    expectMatches: 0,
  },
  // free site with newsletter "Subscribe"
  {
    name: "free site with newsletter subscribe button",
    text: `Subscribe to our newsletter for the latest book releases. تحميل كتاب الكيمياء العضوية مجاناً`,
    expectMatches: 0,
  },
  // free site with Premium membership banner
  {
    name: "free site with Premium membership upsell",
    text: `Free book download. Upgrade to Premium for ad-free experience. علم النفس - PDF مجاني`,
    expectMatches: 0,
  },
  // sidebar showing prices of OTHER books
  {
    name: "sidebar mentions price of unrelated book",
    text: `كتاب التاريخ المعاصر - تحميل مجاني. منتجات أخرى: $9.99 USD - check our store`,
    expectMatches: 1, // only price tag matches; below threshold of 2
  },
  // foulabook free page with "اشتراك" (which contains "اشتر")
  {
    name: "foulabook with اشتراك (subscription) word",
    text: `كتاب الفقه الإسلامي - تحميل مجاني. اشتراك مجاني في النشرة البريدية لتصلك أحدث الكتب`,
    expectMatches: 0,
  },
  // archive.org with عرض price = highest
  {
    name: "archive.org metadata mentioning أعلى سعر in academic context",
    text: `كتاب الاقتصاد - يناقش أعلى سعر للنفط في القرن العشرين - تحميل مباشر`,
    expectMatches: 0,
  },
  // book about commerce with "السعر العادل"
  {
    name: "book ABOUT pricing/commerce (false positive trap)",
    text: `كتاب السعر العادل في الاقتصاد الإسلامي - أحمد محمد - تحميل PDF مجاني`,
    expectMatches: 0,
  },
];

const PAID_BOOK_PAGES = [
  // Real paid book page — 2+ signals
  {
    name: "abjjad — paid book page",
    text: `كتاب رواية - أحمد محمد - السعر: 15 ر.س - اشتر الكتاب الآن - أضف إلى السلة`,
    expectMinMatches: 2,
  },
  // Out of stock with explicit price
  {
    name: "bookstore with out of stock + price",
    text: `Title: Programming Pearls. Price: 25.00 USD. Out of stock. Check back later.`,
    expectMinMatches: 2,
  },
  // Read-only with "غير قابل للتنزيل"
  {
    name: "publisher site read-only + غير متوفر مجاناً",
    text: `كتاب فلسفي - قراءة فقط على موقعنا - غير قابل للتنزيل - غير متوفر مجاناً`,
    expectMinMatches: 2,
  },
  // English commerce page
  {
    name: "Amazon-like page",
    text: `Buy now $19.99 USD - Add to cart - Proceed to checkout - Complete your purchase`,
    expectMinMatches: 2,
  },
];

let passed = 0;
let failed = 0;

console.log("=== FREE book pages (should match < 2 patterns) ===");
for (const tc of FREE_BOOK_PAGES) {
  const hits = countMatches(tc.text);
  const ok = hits === tc.expectMatches;
  console.log(`  ${ok ? "✓" : "✗"} ${tc.name}: hits=${hits}, expected=${tc.expectMatches}`);
  if (ok) passed++;
  else { failed++; console.log(`    text: ${tc.text}`); }
}

console.log("\n=== PAID book pages (should match >= 2 patterns) ===");
for (const tc of PAID_BOOK_PAGES) {
  const hits = countMatches(tc.text);
  const ok = hits >= tc.expectMinMatches;
  console.log(`  ${ok ? "✓" : "✗"} ${tc.name}: hits=${hits}, expected>=${tc.expectMinMatches}`);
  if (ok) passed++;
  else { failed++; console.log(`    text: ${tc.text}`); }
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
