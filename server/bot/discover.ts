// ══════════════════════════════════════════════
// DISCOVER — اكتشاف ذكي بعد التسليم + تلميحات
// ══════════════════════════════════════════════

import { normalizeArabic } from "./text.js";
import { GENRE_MAP, SUGGESTIONS, READING_TIPS } from "./suggestions.js";
import {
  getPrimaryGenre,
  booksForGenreId,
  inferGenre,
} from "./interests.js";
import { seriesAfter } from "./curated.js";

function cleanTitle(raw: string): string {
  return (raw.split(/\s*[—–-]\s*/)[0] || raw).trim().slice(0, 80);
}

function sameBook(a: string, b: string): boolean {
  const na = normalizeArabic(a).toLowerCase();
  const nb = normalizeArabic(b).toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** كتب ذات صلة بنفس التصنيف (من الكتالوج) */
export function relatedFromCatalog(bookName: string, limit = 3): string[] {
  const n = normalizeArabic(bookName).toLowerCase();
  let pool: string[] = [];

  for (const [, books] of Object.entries(GENRE_MAP)) {
    const hit = books.some((b) => {
      const bn = normalizeArabic(b).toLowerCase();
      return bn.includes(n.slice(0, 10)) || n.includes(bn.slice(0, 8)) || sameBook(bookName, b);
    });
    if (hit) {
      pool = books.map(cleanTitle);
      break;
    }
  }

  if (pool.length === 0) {
    // fallback: same inferred genre keyword scan
    const g = inferGenre(bookName);
    pool = booksForGenreId(g).map(cleanTitle);
  }
  if (pool.length === 0) {
    pool = SUGGESTIONS.map(cleanTitle);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  // shuffle stable-ish by hashing book name
  const scored = pool
    .filter((t) => !sameBook(t, bookName))
    .map((t, i) => {
      let h = i * 31;
      for (let j = 0; j < bookName.length; j++) h = (h * 17 + bookName.charCodeAt(j) + t.charCodeAt(0)) >>> 0;
      return { t, h };
    })
    .sort((a, b) => a.h - b.h);

  for (const { t } of scored) {
    const k = normalizeArabic(t).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** مزج: كتالوج مرتبط + ذوق المستخدم */
export async function getRelatedBooks(
  bookName: string,
  userId: string,
  limit = 2,
): Promise<string[]> {
  const series = seriesAfter(bookName, 3);
  const local = [...series, ...relatedFromCatalog(bookName, 6)];
  const primary = await getPrimaryGenre(userId);
  const personalized = primary ? booksForGenreId(primary).map(cleanTitle) : [];

  const out: string[] = [];
  const seen = new Set<string>([normalizeArabic(bookName).toLowerCase()]);

  const push = (t: string) => {
    const k = normalizeArabic(t).toLowerCase();
    if (!k || seen.has(k) || sameBook(t, bookName)) return;
    seen.add(k);
    out.push(t);
  };

  // alternate sources
  let i = 0, j = 0;
  while (out.length < limit && (i < local.length || j < personalized.length)) {
    if (i < local.length) push(local[i++]);
    if (out.length >= limit) break;
    if (j < personalized.length) push(personalized[j++]);
  }
  return out.slice(0, limit);
}

export function pickReadingTip(seed?: string): string {
  const pool = READING_TIPS;
  if (!pool.length) return "📖 _استمتع بالقراءة على مهل._";
  let h = 0;
  const s = seed || String(Date.now());
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

/** جملة اكتشاف تُلحق برسالة النجاح */
export function buildDiscoverFooter(related: string[], tip: string): string {
  if (related.length === 0) {
    return `\n\n${tip}`;
  }
  const lines = related.map((t, i) => `  ${i + 1}. ${t}`).join("\n");
  return (
    `\n\n✨ *قد يعجبك أيضاً:*\n${lines}\n` +
    `_اضغط الزر أدناه لتحميل أحدها مباشرةً._\n\n` +
    `${tip}`
  );
}
