#!/usr/bin/env node
// One-shot cleanup for cached_books rows whose source_url is opaque.
//
// Context (FIX-WRONG-FILE BUG-4):
//   The cache-write guard (`hasUninformativeFilename`) was added in
//   commit b362feb (PR #36) but only catches digit-only URLs. Earlier,
//   pre-PR-#36 traffic poisoned the cache with rows whose URL filename
//   carries zero book-identity signal (Hindawi `/books/53.pdf`,
//   `bookleaks.com/files/server/314.pdf`, etc.). After widening
//   `hasUninformativeFilename` in this PR, the cache writer will refuse
//   such rows for new traffic — but the old rows persist.
//
// What this script does:
//   For every row in `cached_books` whose `source_url`'s filename is
//   classified as opaque by the new (broader) heuristic, delete it.
//   The next user query for those titles falls through to a fresh
//   search → re-validation → re-cache with a properly identified URL.
//
// Telegram file_ids are NOT lost — only the DB pointer. If the bot
// already had the right file cached on Telegram side, a re-run will
// just re-deliver and re-cache (now with stricter guards).
//
// Usage (inside bot container, with DATABASE_URL set):
//   docker compose exec -T bot node script/purge-opaque-cached-books.mjs --dry-run
//   docker compose exec -T bot node script/purge-opaque-cached-books.mjs
//
// Or off the host with explicit URL:
//   DATABASE_URL=postgresql://… node script/purge-opaque-cached-books.mjs --dry-run
//
// Idempotent: a second run after a successful first run finds 0 matches.

import pg from "pg";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("[purge] DATABASE_URL not set");
  process.exit(1);
}

// Same heuristic as pdfValidator.ts hasUninformativeFilename — keep in
// sync if the production logic changes.
function hasUninformativeFilename(u) {
  try {
    const filename = decodeURIComponent(
      new URL(u).pathname.split("/").pop()?.split("?")[0] || "",
    ).replace(/\.pdf$/i, "").trim();
    if (filename.length === 0) return false;
    if (/^\d+$/.test(filename)) return true;
    if (filename.length <= 3 && /^[a-zA-Z0-9_-]+$/.test(filename)) return true;
    const hasAlpha = /[a-zA-Z\u0600-\u06FF]/.test(filename);
    const hasDigit = /\d/.test(filename);
    const hasSep = /[_\-\s]/.test(filename);
    if (hasAlpha && hasDigit && filename.length <= 8 && !hasSep && /^[a-zA-Z0-9]+$/.test(filename)) {
      return true;
    }
    const alphaOnly = filename.replace(/[^a-zA-Z\u0600-\u06FF]/g, "");
    if (hasAlpha && hasDigit && alphaOnly.length < 4) return true;
    return false;
  } catch {
    return false;
  }
}

const client = new pg.Client({ connectionString: url });

async function main() {
  console.log(`[purge] connecting`);
  console.log(`[purge] dry-run: ${dryRun}`);
  await client.connect();

  const { rows } = await client.query(
    "SELECT id, book_query, book_name, source_url FROM cached_books WHERE source_url IS NOT NULL",
  );
  console.log(`[purge] scanning ${rows.length} rows`);

  const opaque = rows.filter((r) => hasUninformativeFilename(r.source_url));
  console.log(`[purge] opaque rows: ${opaque.length}`);

  if (opaque.length === 0) {
    console.log("[purge] nothing to do");
    await client.end();
    return;
  }

  // Print first few for visibility
  for (const r of opaque.slice(0, 10)) {
    console.log(`  - id=${r.id} query="${(r.book_query || "").slice(0, 40)}" url=${(r.source_url || "").slice(0, 80)}`);
  }
  if (opaque.length > 10) console.log(`  ... and ${opaque.length - 10} more`);

  if (dryRun) {
    console.log("[purge] dry-run: not deleting");
    await client.end();
    return;
  }

  const ids = opaque.map((r) => r.id);
  const res = await client.query(
    "DELETE FROM cached_books WHERE id = ANY($1::int[]) RETURNING id",
    [ids],
  );
  console.log(`[purge] deleted ${res.rowCount} rows`);
  await client.end();
}

main().catch((e) => {
  console.error("[purge] error:", e);
  process.exit(1);
});
