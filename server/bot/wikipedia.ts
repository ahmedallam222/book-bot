// ══════════════════════════════════════════════════════════
// Wikipedia summary fetcher (no API key required)
// ══════════════════════════════════════════════════════════
// Used by the summary orchestrator to enrich AI-provider context with
// publicly-known plot/topic/genre info before generating a summary.
// Tries Arabic Wikipedia first (most queries are Arabic books), falls
// back to English. If both fail we just return null and the providers
// summarise the PDF / book name alone.

import { L } from "./logger.js";

interface WikipediaSummary {
  title:    string;
  extract:  string;       // 1-3 paragraph plain-text summary
  url:      string;
  language: "ar" | "en";
}

// Wikipedia REST API: /api/rest_v1/page/summary/{title}
//   - returns 200 with JSON for direct hits
//   - returns 200 with type="disambiguation" for ambiguous titles
//   - returns 404 if no page exists
async function fetchOne(language: "ar" | "en", title: string): Promise<WikipediaSummary | null> {
  const encoded = encodeURIComponent(title.replace(/\s+/g, "_"));
  const url     = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "book-bot/1.0" } });
    if (!r.ok) return null;
    const j = await r.json() as {
      type?: string;
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    if (!j.extract || j.type === "disambiguation") return null;
    return {
      title:    j.title    || title,
      extract:  j.extract,
      url:      j.content_urls?.desktop?.page || `https://${language}.wikipedia.org/wiki/${encoded}`,
      language,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Wikipedia search to disambiguate when a literal title doesn't hit.
// Uses the action=opensearch endpoint which returns the top match
// titles; we then re-resolve via the summary endpoint.
async function searchTitle(language: "ar" | "en", query: string): Promise<string | null> {
  const url = `https://${language}.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&search=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "book-bot/1.0" } });
    if (!r.ok) return null;
    const j = await r.json() as [string, string[], string[], string[]];
    return j?.[1]?.[0] || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchWikipediaContext(bookName: string): Promise<{
  title:    string;
  extract:  string;
  url:      string;
  language: "ar" | "en";
} | null> {
  const t0 = Date.now();
  // Order: Arabic direct → Arabic search → English direct → English search.
  // Most book queries on this bot are Arabic, so AR-first saves a hop.
  const tries: Array<() => Promise<WikipediaSummary | null>> = [
    () => fetchOne("ar", bookName),
    async () => {
      const t = await searchTitle("ar", bookName);
      return t ? fetchOne("ar", t) : null;
    },
    () => fetchOne("en", bookName),
    async () => {
      const t = await searchTitle("en", bookName);
      return t ? fetchOne("en", t) : null;
    },
  ];

  for (const t of tries) {
    const r = await t();
    if (r) {
      L.info("wikipedia", "context found", {
        book:   bookName.slice(0, 50),
        lang:   r.language,
        ms:     Date.now() - t0,
        chars:  r.extract.length,
      });
      return r;
    }
  }
  L.info("wikipedia", "no context", { book: bookName.slice(0, 50), ms: Date.now() - t0 });
  return null;
}
