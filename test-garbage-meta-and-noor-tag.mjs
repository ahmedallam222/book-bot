// Probes for the garbage-/Title detection in pdfValidator and the
// non-book-URL early reject in noorBookResolver.
// Run from repo root: npx tsx test-garbage-meta-and-noor-tag.mjs

let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${label} — got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (ok) pass++; else fail++;
};

// ── Test 1: looksLikeUselessTitle (mirror of pdfValidator helper) ──
function looksLikeUselessTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (t.length === 0) return true;
  if (!/[a-zA-Z\u0600-\u06FF]/.test(t)) return true;
  const garbagePatterns = [
    /^\s*\d+\s*image\s*\d*\s*$/i,
    /^\s*image\s*\d+\s*$/i,
    /^\s*untitled\s*[-_]?\s*\d*\s*$/i,
    /^\s*بدون\s*عنوان\s*$/,
    /^\s*document\s*\d*\s*$/i,
    /^\s*microsoft\s*word\s*[-–]/i,
    /^\s*slide\s*\d+\s*$/i,
    /^\s*page\s*\d+\s*$/i,
    /^\s*new\s*document\s*\d*\s*$/i,
    /^\s*pdf\s*\d*\s*$/i,
    /^\s*book\s*\d*\s*$/i,
    /^\s*كتاب\s*\d*\s*$/,
    /^\s*ملف\s*\d*\s*$/,
  ];
  if (garbagePatterns.some((re) => re.test(t))) return true;
  const lettersOnly = t.replace(/[^a-zA-Z\u0600-\u06FF]/g, "");
  if (lettersOnly.length <= 3) return true;
  return false;
}

// Garbage cases (should be flagged)
expect("garbage: '1 Image' (Hindawi prod)",         looksLikeUselessTitle("1 Image"),                       true);
expect("garbage: 'Image 1'",                         looksLikeUselessTitle("Image 1"),                       true);
expect("garbage: 'image001'",                        looksLikeUselessTitle("image001"),                      true);
expect("garbage: 'Untitled'",                        looksLikeUselessTitle("Untitled"),                      true);
expect("garbage: 'Untitled-1'",                      looksLikeUselessTitle("Untitled-1"),                    true);
expect("garbage: 'بدون عنوان'",                      looksLikeUselessTitle("بدون عنوان"),                    true);
expect("garbage: 'Document1'",                       looksLikeUselessTitle("Document1"),                     true);
expect("garbage: 'Microsoft Word - draft.docx'",     looksLikeUselessTitle("Microsoft Word - draft.docx"),   true);
expect("garbage: 'Slide 1'",                         looksLikeUselessTitle("Slide 1"),                       true);
expect("garbage: 'PDF'",                             looksLikeUselessTitle("PDF"),                           true);
expect("garbage: 'كتاب'",                            looksLikeUselessTitle("كتاب"),                          true);
expect("garbage: '   ' (whitespace only)",           looksLikeUselessTitle("   "),                           true);
expect("garbage: '123' (no letters)",                looksLikeUselessTitle("123"),                           true);
expect("garbage: 'a' (single char)",                 looksLikeUselessTitle("a"),                             true);
expect("garbage: 'Doc' (3-char)",                    looksLikeUselessTitle("Doc"),                           true);

// Legitimate titles (must NOT be flagged)
expect("legit: 'رياض الصالحين'",                     looksLikeUselessTitle("رياض الصالحين"),                 false);
expect("legit: 'Atomic Habits'",                     looksLikeUselessTitle("Atomic Habits"),                 false);
expect("legit: 'كتاب الأمير - نيكولو ميكافيلي'",     looksLikeUselessTitle("كتاب الأمير - نيكولو ميكافيلي"), false);
expect("legit: 'The Great Gatsby (1925)'",           looksLikeUselessTitle("The Great Gatsby (1925)"),       false);
expect("legit: 'Documentary' (not Document)",        looksLikeUselessTitle("Documentary"),                   false);
expect("legit: 'Slidewalk' (not Slide N)",           looksLikeUselessTitle("Slidewalk"),                     false);
expect("legit: 'Imagery' (not Image N)",             looksLikeUselessTitle("1 Imagery"),                     false);
expect("legit: empty string",                        looksLikeUselessTitle(""),                              false);

// ── Test 2: isNonBookNoorUrl (mirror of noorBookResolver helper) ──
const NON_BOOK_NOOR_PATTERNS = [
  /^\/tag\//i,
  /^\/category\//i,
  /^\/user\//i,
  /^\/author\//i,
  /^\/search(?:\?|\/|$)/i,
  /^\/البحث/,
  /^\/بحث(?:\?|\/|$)/,
  /^\/أحدث-/,
  /^\/الفئة\//,
  /^\/المستخدم\//,
];

function isNonBookNoorUrl(url) {
  try {
    const path = new URL(url).pathname;
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch {}
    return NON_BOOK_NOOR_PATTERNS.some((re) => re.test(decoded));
  } catch { return false; }
}

// Non-book URLs (must be flagged)
expect("noor non-book: /tag/ from prod",   isNonBookNoorUrl("https://www.noor-book.com/tag/%D9%83%D9%8A%D9%81-%D8%AA%D8%AA"),                                                       true);
expect("noor non-book: /tag/ علاج",        isNonBookNoorUrl("https://www.noor-book.com/tag/%D8%B9%D9%84%D8%A7%D8%AC-%D8%A7%D9%84%D8%B1%D9%87"),                                     true);
expect("noor non-book: /category/",         isNonBookNoorUrl("https://www.noor-book.com/category/%D8%A3%D8%AF%D8%A8"),                                                                true);
expect("noor non-book: /user/",             isNonBookNoorUrl("https://www.noor-book.com/user/12345"),                                                                                  true);
expect("noor non-book: /author/",           isNonBookNoorUrl("https://www.noor-book.com/author/dostoyevsky"),                                                                          true);
expect("noor non-book: /search?q=",         isNonBookNoorUrl("https://www.noor-book.com/search?q=foo"),                                                                                true);
expect("noor non-book: /البحث (Arabic)",   isNonBookNoorUrl("https://www.noor-book.com/البحث?q=رواية"),                                                                              true);
expect("noor non-book: /أحدث-",            isNonBookNoorUrl("https://www.noor-book.com/أحدث-الكتب"),                                                                                  true);

// Real book pages (must NOT be flagged)
expect("noor book: /كتاب-آنا-كارنينا-pdf", isNonBookNoorUrl("https://www.noor-book.com/كتاب-آنا-كارنينا-pdf"),                                                                       false);
expect("noor book: /book/12345",            isNonBookNoorUrl("https://www.noor-book.com/book/12345"),                                                                                  false);
expect("noor book: homepage",               isNonBookNoorUrl("https://www.noor-book.com/"),                                                                                            false);
expect("noor book: 'tag' substring in name", isNonBookNoorUrl("https://www.noor-book.com/كتاب-tag-systems"),                                                                          false);

console.log(`\n${pass}/${pass+fail} passed`);
process.exit(fail === 0 ? 0 : 1);
