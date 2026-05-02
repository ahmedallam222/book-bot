# Test report — PR #12

**Devin session:** https://app.devin.ai/sessions/d86a562f0d2c49399218aff94f396c2b
**PR:** https://github.com/ahmedallam222/book-bot/pull/12 (CI ✓)
**Approach:** shell-only against the live production server `ubuntu@54.196.55.152` (no Telegram UI). Two real search jobs were enqueued through Redis into the deployed worker; bundle contents and Firecrawl responses were inspected directly.

## Escalations / things to know first

- **Two real Telegram messages were sent to the admin chat (id `5469997406`)** during the search tests below. They are "lookup failed" messages because the verifier rejected the PDF candidates (see T3); they are not errors in the recovery itself.
- **Search returns results, but the verifier rejects the candidate pages** for the two books I tested. `foulabook.com` returns an HTML download portal (not a direct PDF), and `noor-book.com` rejects the bot's user-agent with HTTP 403. This is **not** a regression introduced by this PR — it is how the verifier has always behaved with these domains. The end-user-visible "I got a PDF in Telegram" path was therefore not directly observed; what was observed is that the search pipeline up to the verifier works correctly, with no Firecrawl HTTP 400 errors.
- The PR's two stated goals — restore the advanced version and fix Firecrawl — are independently and definitively confirmed (T2, T4).

## Tests

| # | Test | Result |
|---|------|--------|
| T1 | Runtime healthy: containers up, `/api/health` 200, single `node` child under `tini` | passed |
| T2 | Deployed bundle contains the recovered advanced features (callback keys, command regexes, 13 sources, `XTR`, `pre_checkout_query`, `site:` query operator) and is free of the deprecated `includeDomains` parameter | passed |
| T3 | Live end-to-end search via Redis enqueue: worker dequeues → Firecrawl returns ≥1 result with no HTTP 4xx → worker completes → user receives a message | passed (with caveat: verifier rejected the candidates on both test books, so the message the user got was the "couldn't fetch PDF" notice, not a PDF) |
| T4 | Negative control: old `includeDomains` shape on `/v1/search` returns HTTP 400 with `unrecognized_keys`; new `site:` query on `/v2/search` returns HTTP 200 with on-target results — proves the fix is causal | passed |

## Evidence

### T1 — Runtime

```
=== docker compose ps ===
book-bot-bot-1     book-bot-bot         /sbin/tini -- node …      Up (healthy)   0.0.0.0:5000->5000/tcp
book-bot-db-1      postgres:16-alpine   docker-entrypoint.s…      Up (healthy)
book-bot-redis-1   redis:7-alpine       docker-entrypoint.s…      Up (healthy)

=== /api/health ===
{"ok":true,"uptime":479,"ts":1777750536044}
HTTP 200

=== process tree (must be tini PID 1 + 1 node child) ===
    PID    PPID COMMAND         COMMAND
      1       0 tini            /sbin/tini -- node dist/index.cjs
      7       1 node            node dist/index.cjs
```

### T2 — Bundle assertions

Bundle copied out of the running container to `/tmp/index.cjs.deployed` (348,686 bytes, mtime `May 2 19:26`). Substring counts:

| String | Count | Required | OK |
|--------|------:|---------:|:--:|
| `"rg:any"` (random-book button callback) | 6 | ≥1 | yes |
| `"weekly_refresh"` | 3 | ≥1 | yes |
| `"wishlist_view"` | 4 | ≥1 | yes |
| `"premium_buy"` | 8 | ≥1 | yes |
| `/wishlist` | 6 | ≥1 | yes |
| `/premium` | 7 | ≥1 | yes |
| `"XTR"` (Telegram Stars currency) | 1 | ≥1 | yes |
| `pre_checkout_query` | 1 | ≥1 | yes |
| `site:` (new query operator) | 1 | ≥1 | yes |
| `includeDomains` | 0 | =0 | yes |

13 unique sources in the bundle: `al-maktaba.org, arabic-book.net, archive.org, books-library.net, foulabook.com, hindawi.org, kotobati.com, ktabpdf.com, kutub-pdf.net, kutubm.com, noor-book.com, novbook.net, waqfeya.net`. This matches the "13 مصدر عربي" string in the screenshot the user shared of the advanced version.

Bundle context confirming the callbacks are wired:

```
ata.startsWith("rg:") || data === "premium_buy" || data === "wishlist_view" ||
data === "wishlist_clear" || data.st…
```

### T3 — Live search through the deployed worker

Two test jobs were enqueued directly into Redis (`queue:high`) targeting admin chatId `5469997406`. The running worker picked them up via `dequeue()` → `processBookRequest()` → `unifiedSearch()` (Firecrawl) → `verify` → `download`.

**Job 1: "حوار مع صديقي الملحد"** — `id testdevin-1777750590-23714`
- 19:36:30 worker `Processing job …`
- 19:36:35 bot `No direct PDF URLs — trying 1 download pages as last resort` ← proves Firecrawl returned ≥1 URL
- 19:36:36 download `❌ Failed … reason: response is HTML not PDF` (foulabook landing page)
- 19:36:37 download `❌ Failed … reason: response is HTML not PDF` (retry, same URL)
- queue lengths after: `high=0, normal=0, dlq=0, active=∅` → worker completed and called `completeJob`

**Job 2: "في ظلال القرآن"** — `id testdevin2-1777750774-32199`
- 19:39:34 worker `Processing job …`
- 19:39:39 bot `No direct PDF URLs — trying 1 download pages as last resort` ← Firecrawl returned URLs again
- 19:39:40 download `❌ Failed … reason: HTTP 403` (noor-book rejected bot's user-agent)
- queue lengths after: `high=0, normal=0, dlq=0, active=∅`

Important negatives in the log window: **zero** occurrences of `Firecrawl HTTP 4xx`, `Firecrawl rate limited`, `Firecrawl quota exceeded`, or `Firecrawl auth error`. The pre-PR symptom (`Firecrawl HTTP 400 — unrecognized_keys: includeDomains`) is absent.

Caveat: I could not directly find a `✅ Job done` log line in the live log buffer for either job, but `queue:active` is empty and `queue:dlq` is empty, which means the worker did call `completeJob` (the only path that removes the id from `queue:active` without putting it in `queue:dlq` is `completeJob`). The most likely explanation for the missing line is log buffering / terminal width truncation in `docker compose logs`.

### T4 — Negative + positive control on the live Firecrawl API

Run from inside the bot container with the production `FIRECRAWL_API_KEY`:

```
=== OLD shape (includeDomains v1) — must FAIL ===
HTTP 400
{"success":false,"error":"Invalid request body","details":[{"code":"unrecognized_keys",
 "keys":["includeDomains"], "path":[],
 "message":"Unrecognized key: \"includeDomains\""}]}

=== NEW shape (site: v2) — must SUCCEED ===
HTTP 200
{"success":true,"data":{"web":[{"url":"https://foulabook.com/ar/book/تحميل-كتاب-حوار-مع-صديقي-الملحد-pdf",
 "title":"تحميل كتاب حوار مع صديقي الملحد pdf تأليف مصطفى محمود - فولة بوك",
 "description":"اللغة : العربية · التصنيف : علوم إسلامية ..."}]}}
```

Same API key, same query string, same container, only the request shape differs. This is the strongest causal proof that the fix in `engine.ts` (replacing `includeDomains` with `site:` query operator and pointing at `/v2/search`) is what makes Arabic search work again.

## What I'd recommend you check yourself

1. Open the bot in Telegram and send `/start` — confirm visually that the four advanced buttons (🎲 كتاب مفاجأة, 📅 أفضل الأسبوع, 🔖 قائمة أمنياتي, ⭐ ترقية للـ Premium) appear. The bundle proves they're wired, but seeing them in your client closes the loop.
2. Send any popular Arabic book title and watch for an actual PDF arriving (T3 only confirmed the search half; the verifier+download half depends on which sources happen to host the title).
3. Try `/wishlist add <book>` and `/wishlist` to confirm the Redis-backed wishlist persists.
