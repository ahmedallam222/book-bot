---
name: testing-book-bot
description: Test the Telegram book-bot production runtime, source quality, and deterministic backend cache/search behavior.
---

# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, deployment health, or smart cached-PDF behavior.

## Devin Secrets Needed

- `FIRECRAWL_API_KEY` — needed for local/dev Firecrawl-backed searches if running the bot outside production.
- `AWS_UBUNTU_SSH_PRIVATE_KEY` or an equivalent SSH key provisioned at `$HOME/.ssh/devin_aws_ubuntu_key` — needed to access the production Ubuntu server.
- For the AI summary engine: `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_MODELS_TOKEN`, `MISTRAL_API_KEY`, `CLOUDFLARE_AI_ACCOUNT_ID`, `CLOUDFLARE_AI_API_TOKEN`, `YOU_COM_API_KEY`. All optional except Gemini — the registry degrades gracefully.

Do not print production `.env` values. Production runtime secrets live in `/home/ubuntu/book-bot/.env` on the server.

## Production environment

- AWS server: `ubuntu@<production-host>`, SSH port 22.
- Deployment directory: `/home/ubuntu/book-bot`.
- Runtime: Docker Compose services `bot`, `db`, and `redis`.
- Health/status: `cd /home/ubuntu/book-bot && docker compose ps bot`.
- Logs: `cd /home/ubuntu/book-bot && docker compose logs --tail=120 bot`.
- Dashboard/admin API is served by the running bot server on port 5000. Use `DASHBOARD_SECRET` from inside the bot container for authenticated admin API probes.
- `/home/ubuntu/posts/bot.py` is a separate daily-posting script. Do not modify or delete it during book-bot tests.

## Critical safety rule

Do **not** run `node -e 'require("/app/dist/index.cjs")'` or otherwise import the bundled production entrypoint inside the running bot container. Importing the entrypoint starts a second Telegram polling process and can cause `ETELEGRAM 409 Conflict` errors.

Instead, test through the already-running process using:

```bash
cd /home/ubuntu/book-bot
# public health
docker compose exec -T bot node - <<'NODE'
const http = require('http');
http.get('http://127.0.0.1:5000/api/health', (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => { console.log(res.statusCode, body); process.exit(res.statusCode === 200 ? 0 : 1); });
}).on('error', (err) => { console.error(err.message); process.exit(1); });
NODE
```

## Local deterministic cache/search tests

For backend-only cache/search/ranking changes, prefer shell-only probes over Telegram UI tests when the behavior is deterministic and does not require real Firecrawl or Telegram delivery.

Useful checks:

```bash
# Verify smart cache key behavior without secrets.
npx tsx -e 'import { normalizeBookCacheKey } from "./server/bot/text.ts"; const cases=["أرض زيكولا","ارض زيكولا","تحميل كتاب أرض زيكولا pdf","رواية أرض زيكولا نسخة pdf"]; for (const c of cases) console.log(c,"=>",normalizeBookCacheKey(c));'

# Always verify TypeScript and bundled output.
npm run typecheck
npm run build
```

Expected for smart cached-PDF query matching: Arabic spelling variants and generic request wrappers such as `تحميل كتاب ... pdf` should resolve to the same canonical cache key. If storage cache behavior changes, also verify reads remain backward-compatible with legacy `book_query_normalized` rows.

## Testing the AI summary engine offline (no Telegram needed)

The summary feature (PR #19) ships a 9-provider AI failover stack. Before deploying engine-level changes (new providers, prompt edits, cache TTL changes, quota tweaks), run an adversarial harness against a local Redis with the real provider HTTP APIs. This validates the engine without sending a single Telegram message.

### Setup

```bash
# Start a throwaway Redis (port 6379).
docker run -d --name test-redis-summary -p 6379:6379 redis:7-alpine

# Register only the AI keys you have (the registry skips unconfigured providers).
export REDIS_URL=redis://127.0.0.1:6379
# GEMINI_API_KEY, GROQ_API_KEY, etc. should already be in your env from the secrets store.
```

### Pattern: tsx harness importing the engine directly

Write a small `_test_summary.ts` at the repo root that imports `getBookSummary`, `checkAndConsumeUsage`, `kbAfterSuccess`, `normalizeForCache`, and `SUMMARY_DAILY_LIMIT_FREE`. Run with `npx tsx _test_summary.ts`. Cover at least these six cases — each is designed so a broken implementation produces visibly different output:

1. **PDF tier success** — send a known Hindawi PDF URL (e.g. `https://downloads.hindawi.org/books/61851406.pdf` for كليلة ودمنة). Assert `source==='pdf'`, `providerName.startsWith('gemini-')`, summary 600–3500 chars, ≥100 Arabic chars (`/[\u0600-\u06FF]/g`), `bookType !== 'unknown'`, latency < 60s, and that the Redis cache key `summary:v1:<normalizeForCache(book)>` exists after the call.
2. **Novel spoiler-protection** — request `آنا كارنينا` with no PDF (forces text-tier through Wikipedia context). Assert `bookType==='novel'`, `spoilerLevel ∈ {critical, moderate}`, summary does NOT contain `/تنتحر|انتحار|قطار|ألقت\s*بنفسها/`, `source ∈ {context, wikipedia_only}`. Verify the keyboard would render `📖 *ملخص الرواية* — _بدون أي حرق_` for `spoilerLevel='critical'` or `📖 *ملخص الرواية*` for moderate.
3. **Cache hit** — call `getBookSummary` twice for the same book. L2 must be < 200ms (typically 0–1ms), L2/L1 < 0.05, summaries deeply equal, providerName equal, Redis TTL between 2.5M–2.592M seconds (~30 days).
4. **Failover** — set `ai:breaker:gemini-2.5-flash`, `ai:breaker:gemini-2.0-flash`, and `ai:breaker:gemini-flash-lite-latest` to `1` with TTL 600 in Redis, then call. Assert providerName is NOT a `gemini-*` and is one of the text-tier set (groq, cerebras, sambanova, openrouter, github-models, mistral, cloudflare, wikipedia-fallback). Always clean up the breaker keys afterward.
5. **Keyboard wiring** — call `kbAfterSuccess(book, sessionId)` and assert `inline_keyboard[0].length === 1`, text matches exactly `📘  ملخص الكتاب` (note the double-space — deliberate), callback_data matches `/^sum:[0-9a-f]{12}$/`, and `Buffer.byteLength(callback_data, 'utf8') <= 64`.
6. **Quota cap** — with a fresh user id, call `checkAndConsumeUsage(uid, false)` `limit + 1` times. The first `limit` must return `blocked=false` with the counter incrementing 1..limit. The `limit + 1`th must return `blocked=true` with the Redis counter rolled back to `limit` (NOT `limit + 1`). One more call with `premium=true` must return `blocked=false` without changing the counter.

### Gemini-API gotchas (May 2026)

- **`gemini-2.5-flash` requires `thinkingConfig: { thinkingBudget: 0 }`.** With the default thinking budget, Gemini 2.5 Flash spends ~95% of `maxOutputTokens` on internal reasoning (`thoughtsTokenCount` in `usageMetadata`), leaving only a few tokens for the actual response. The JSON arrives truncated mid-string and the response parser falls back to `bookType: 'unknown'` — which silently breaks novel spoiler-protection. Always set `thinkingBudget: 0` for non-reasoning tasks like JSON extraction. Also set `maxOutputTokens >= 2048` for safety margin.
- **`gemini-1.5-flash` was retired from `v1beta`** and now returns `HTTP 404`. Use `gemini-flash-lite-latest` (alias for the latest stable lite Flash) as the deepest Gemini fallback.
- **`gemini-2.0-flash` may return `RESOURCE_EXHAUSTED` with `limit: 0`** on some accounts — this is a Google billing-tier signal, not a code bug. Don't waste time debugging.
- **List available models** with `curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"` to verify model names before assuming.

## Safe runtime test checklist

1. Confirm only one actual Node process is running. The container normally has a `tini` wrapper plus one `node` child:

```bash
cd /home/ubuntu/book-bot
docker compose exec -T bot sh -lc 'ps -o comm= | grep -c "^node$" || true; ps -o pid,ppid,comm,args'
```

Expected: count is `1`, and the process table shows `node dist/index.cjs` under `/sbin/tini -- node dist/index.cjs`.

2. Confirm container/server health:

```bash
cd /home/ubuntu/book-bot
docker compose ps bot
docker compose exec -T bot node -e 'const http=require("http");http.get("http://127.0.0.1:5000/api/health",r=>{let b="";r.on("data",c=>b+=c);r.on("end",()=>{console.log(r.statusCode,b);process.exit(r.statusCode===200&&JSON.parse(b).ok===true?0:1)})}).on("error",e=>{console.error(e.message);process.exit(1)})'
```

Expected: Docker status is `healthy`; `/api/health` returns HTTP 200 with `ok: true`.

3. Verify Arabic UX/source-health strings from deployed source without importing the app. Strip Arabic tashkeel/combining marks before exact phrase checks because production copy may include diacritics such as `تحميلًا`/`مضمونًا`.

Expected phrases include:

- `لا يوجد PDF مباشر صالح للإرسال`
- `PDF فشل`
- `تحميل محتمل`
- `مدفوع/قراءة فقط`
- `هذه نتائج معاينة وليست تحميلا مضمونا` after normalization
- `⛔`
- `معطل تلقائيا` after normalization
- `autoDisabled`
- `stats:source:`

4. Verify source auto-disable through the running admin API with an isolated Redis key, then clean it up:

```bash
cd /home/ubuntu/book-bot
TEST_DOMAIN='devin-test-source.invalid'
docker compose exec -T redis redis-cli del "stats:source:${TEST_DOMAIN}" >/dev/null
docker compose exec -T redis redis-cli hset "stats:source:${TEST_DOMAIN}" ok 0 fail 8 >/dev/null
docker compose exec -T bot sh -lc 'node -e "const http=require(\"http\");const domain=\"devin-test-source.invalid\";const secret=process.env.DASHBOARD_SECRET;http.get({hostname:\"127.0.0.1\",port:5000,path:\"/api/admin/stats/sources\",headers:{Authorization:\"Bearer \"+secret}},res=>{let body=\"\";res.on(\"data\",c=>body+=c);res.on(\"end\",()=>{const parsed=JSON.parse(body);const row=parsed.data.find(s=>s.domain===domain);console.log(res.statusCode, JSON.stringify(row));process.exit(res.statusCode===200&&parsed.ok===true&&row&&row.ok===0&&row.fail===8&&row.rate===\"0%\"&&row.autoDisabled===true?0:1)})}).on(\"error\",e=>{console.error(e.message);process.exit(1)})"'
docker compose exec -T redis redis-cli del "stats:source:${TEST_DOMAIN}" >/dev/null
docker compose exec -T redis redis-cli exists "stats:source:${TEST_DOMAIN}"
```

Expected: API returns the isolated row with `ok: 0`, `fail: 8`, `rate: "0%"`, `autoDisabled: true`; cleanup `EXISTS` returns `0`.

5. Check recent logs after testing:

```bash
cd /home/ubuntu/book-bot
START_TS=$(date -u -d '2 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
docker compose logs --since="$START_TS" bot 2>&1 | grep -E 'uncaughtException|Firecrawl HTTP 401|Invalid token|409 Conflict' || true
```

Expected: no matches after test recovery. Historical 409 lines may exist if a previous session accidentally started a second polling process; final state should still show one actual Node process and no recent 409s.

## Reporting limitations

If no logged-in Telegram Web/test-chat session is available, explicitly mark literal chat UI testing as untested. Ask Ahmed to send messages while logs are monitored, or provide a test Telegram session, if full chat UI proof is required.
