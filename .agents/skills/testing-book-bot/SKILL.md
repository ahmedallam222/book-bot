---
name: testing-book-bot
description: Test the Telegram book-bot production runtime, source quality, and deterministic backend cache/search behavior.
---

# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, deployment health, smart cached-PDF behavior, admin-toggle/event-driven features such as maintenance-mode announcements, or admin agent features (knowledge base, proactive monitoring, ReAct tools).

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

## Critical safety rules

Do **not** run `node -e 'require("/app/dist/index.cjs")'` or otherwise import the bundled production entrypoint inside the running bot container. Importing the entrypoint starts a second Telegram polling process and can cause `ETELEGRAM 409 Conflict` errors.

The bot container does **not** include `curl` — only `wget` (used by the healthcheck) is available inside it. For HTTP probes, either:

- Run `curl` from the host against `http://127.0.0.1:5000` (the bot's port mapping is `5000:5000`), reading `DASHBOARD_SECRET` via `docker compose exec -T bot printenv DASHBOARD_SECRET`, or
- Use the embedded-`node` snippet pattern shown in the health check below.

Instead of importing the bundle, test through the already-running process using:

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

## Deploy a merged PR to production and verify

Verified pattern when a PR is merged into `main` and the production server needs to be rolled forward.

```bash
ssh -i $HOME/.ssh/devin_aws_ubuntu_key ubuntu@<production-host>
cd /home/ubuntu/book-bot

# 1. Stash untracked .env.backup-* files so they survive a branch switch.
#    The server may have leftover env-rotation artifacts that should not be lost.
git stash push -u -m "pre-deploy-$(date +%s)" -- '.env.backup-*' || true

# 2. Fast-forward to origin/main. The server may sit on an old Devin work
#    branch — confirm there are no unique commits before checkout.
git fetch --quiet origin
git log --oneline HEAD..origin/main      # commits to be deployed
git log --oneline origin/main..HEAD      # MUST be empty before continuing
git checkout main && git pull --ff-only origin main

# 3. Rebuild the image. compose builds bot from . so this regenerates dist.
docker compose build bot

# 4. Recreate the container and wait ~30 s for the healthcheck.
docker compose up -d bot
sleep 30
docker compose ps bot              # expect: Up <time> (healthy)

# 5. Confirm the deploy actually shipped the new code by greping a unique
#    marker introduced by the PR inside the bundled output. Choose a token
#    that did not exist before (a new identifier, comment, or string literal).
docker compose exec -T bot grep -c '<NEW_MARKER>' /app/dist/index.cjs

# 6. Restore the env backup.
git stash pop || true
```

Fail signals: `git pull` reports a non-fast-forward, `docker compose ps` reports `unhealthy`, the marker grep returns `0` (deploy used a stale layer or wrong branch), or the post-deploy logs contain `ETELEGRAM 409 Conflict` (old container did not stop).

## Testing internal modules that need the bot's Redis (sidecar-container pattern)

When testing a module that imports `./server/bot/redis.js` (e.g. AI providers, validators, suggestions, transliteration), running `npx tsx _harness.ts` directly on the EC2 host **fails with `ECONNREFUSED 127.0.0.1:6379`**. The bot's docker-compose Redis is on the internal `book-bot_default` network with no port binding to host.

Fix: run the harness inside a sidecar `node:22-bookworm-slim` container attached to the same docker network and pointed at `redis:6379` (the docker service name).

```bash
cd /home/ubuntu/book-bot
set -a && source .env && set +a   # load CLOUDFLARE_AI_*, etc.

# 1. Write your harness at the repo root (mounted into /app inside the container).
#    Imports work as expected: `import { foo } from "./server/bot/aiProviders/foo.js";`

# 2. Run inside a sidecar container on the bot's network.
docker run --rm \
  --network book-bot_default \
  -v /home/ubuntu/book-bot:/app \
  -w /app \
  -e REDIS_URL=redis://redis:6379 \
  -e CLOUDFLARE_AI_ACCOUNT_ID=$CLOUDFLARE_AI_ACCOUNT_ID \
  -e CLOUDFLARE_AI_API_TOKEN=$CLOUDFLARE_AI_API_TOKEN \
  node:22-bookworm-slim \
  npx tsx _harness.ts
```

Why this works:
- `--network book-bot_default` puts the sidecar in the same docker network as `bot` and `redis`, so DNS resolves `redis` to the right container.
- `-v /home/ubuntu/book-bot:/app` shares the source tree (and `node_modules` — already installed for tsx, ioredis, etc.) so no `npm install` is needed.
- The bot's prod container is **untouched** — there is no risk of starting a second Telegram polling process inside it.

Gotchas learned in practice:

- **Counter constants for cache-hit may not exist on the module.** Some modules (e.g. `llamaValidator`) write the verdict cache in the *caller* (here `pdfValidator.ts` writes to `mv:` keys), not in the module itself. So there is no `TEL_LLAMA_CACHE_HIT` export. Before importing every counter constant, grep for `^export const TEL_` in the module and import only what's actually exported. For cache-hit assertions, fall back to a raw key string.
- **`redis.incr(...).catch(() => {})` is fire-and-forget.** Snapshot Redis ~200 ms after the call, not immediately, otherwise counters look like `0` because the increment hasn't flushed.
- **The harness file should be temporary.** Place it at the repo root (e.g. `_test_<feature>.ts`), run it, then delete. Do **not** commit harness files — they're not part of CI and bypass the deterministic test suite.
- **Cache pollution is usually harmless.** A working module's cache write stores legitimate output (e.g. `tlit:llama:<hash>` → `{"corrected":"ويندي درايدن"}`). This is indistinguishable from real traffic. Skip cleanup unless your test inputs are nonsense.
- **Counter increments persist** in prod Redis, so a passing test leaves `+1` (or `+2`) on each counter. This is normally fine — they're observability counters, not state. If you need a clean baseline, snapshot before the test and report deltas, not absolute values.

Example assertions for any Llama-style fail-open module:

```ts
// L1: fresh CF call
//   - return is one of <expected verdict types>
//   - tel:<ns>:<feature>_used incremented by exactly 1
//   - exactly ONE of the verdict sub-counters incremented by 1
//   - NONE of *_http_error / *_timeout / *_other_error / *_no_key incremented
//   - latency below the module's hard timeout

// L2: identical second call
//   - returns deep-equal value (cache hit) OR same value (deterministic re-fetch)
//   - if module owns cache: _used did NOT increment, _cache_hit incremented by 1, latency < 200ms
//   - if cache lives in caller: _used incremented again — document this as expected behaviour
```

Validated 2026-05-10 on the Llama-on-CF trio (PRs #140 / #141 / #142): 6/6 assertions passed end-to-end; `correctTransliteration("لي وتيدصي درايدن")` returned `"ويندي درايدن"` in 179 ms.

## Local deterministic cache/search/parser tests

For backend-only cache/search/ranking/parser changes, prefer shell-only probes over Telegram UI tests when the behavior is deterministic and does not require real Firecrawl or Telegram delivery.

Useful checks:

```bash
# Verify smart cache key behavior without secrets.
npx tsx -e 'import { canonicalizeForCache } from "./server/bot/text.ts"; const cases=["أرض زيكولا","ارض زيكولا","تحميل كتاب أرض زيكولا pdf","رواية أرض زيكولا نسخة pdf"]; for (const c of cases) console.log(c,"=>",canonicalizeForCache(c));'

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

## Testing the admin agent (ReAct tools, knowledge base, proactive monitoring)

The admin agent runs as a separate Telegram bot (`@kholasa_admin_bot`). Without a Telegram client session, test via bundle inspection, Redis state manipulation, and log verification.

### Verifying new tools are deployed

After deploying admin agent changes, confirm each tool name appears in the production bundle:

```bash
cd /home/ubuntu/book-bot
for tool in think save_knowledge recall_knowledge delete_knowledge trigger_health_check get_proactive_log diagnose; do
  echo -n "$tool: "
  docker compose exec -T bot grep -c "\"$tool\"" /app/dist/index.cjs
done
```

Expected: each tool returns ≥1. If 0, the tool definition wasn't compiled into the bundle.

### Arabic text in esbuild bundles — gotcha

esbuild escapes Arabic characters as uppercase Unicode sequences (e.g. `\u062A` not `\u062a`) in string literals. Direct `grep` or `String.includes()` with raw Arabic text through SSH + `docker exec` may fail due to encoding mismatches.

**Workaround**: Use Node.js inside the container to search for escaped sequences, or search for a unique ASCII anchor near the Arabic text:

```bash
# Search via escaped sequence (note uppercase hex)
docker compose exec -T bot node -e "
const code = require('fs').readFileSync('/app/dist/index.cjs','utf8');
console.log('found:', code.includes('\\\\u0644\\\\u0627 \\\\u062A\\\\u062A\\\\u0639'));
"

# Or search via ASCII anchor nearby
docker compose exec -T bot node -e "
const code = require('fs').readFileSync('/app/dist/index.cjs','utf8');
const idx = code.indexOf('success_rate = found/requests');
console.log('context:', code.slice(idx, idx+300));
"
```

### Testing Knowledge Base CRUD via Redis

The KB uses Redis hash `admin:agent:kb`. Each field is a key, and the value is JSON `{"value":"...","updatedAt":<unixMs>}`.

```bash
cd /home/ubuntu/book-bot

# Write
docker compose exec -T redis redis-cli HSET admin:agent:kb "test_key" \
  '{"value":"test value here","updatedAt":1747028400000}'
# Expected: 1 (new) or 0 (updated)

# Read
docker compose exec -T redis redis-cli HGET admin:agent:kb "test_key"
# Expected: exact JSON back

# Count
docker compose exec -T redis redis-cli HLEN admin:agent:kb
# Expected: ≥1

# Delete
docker compose exec -T redis redis-cli HDEL admin:agent:kb "test_key"
# Expected: 1

# Confirm
docker compose exec -T redis redis-cli HGET admin:agent:kb "test_key"
# Expected: (nil)
```

Always clean up test entries to avoid polluting the agent's real knowledge base.

### Verifying proactive monitoring

Proactive monitoring starts on boot with a 5-minute initial delay, then runs hourly. After the first check, results are logged to `admin:agent:proactive:log` (Redis list, capped at 100).

```bash
# Confirm monitoring started in boot logs
docker compose logs bot --no-log-prefix 2>&1 | grep "monitoring started"
# Expected: [proactive] monitoring started (interval=60min)

# Check health check log (may be empty if <5 min since boot)
docker compose exec -T redis redis-cli LRANGE admin:agent:proactive:log 0 2
# Expected after first check: JSON with ts, alerts, requests, successRate, pending, dlq
```

Health check thresholds (from `proactive.ts`):
- Success rate alert: < 50% (with ≥10 requests)
- Queue backlog alert: > 50 pending
- DLQ overflow alert: > 20 jobs
- Source auto-pause: failure rate > 80% (with ≥5 attempts)
- Alert cooldown: 4 hours per alert type

Related Redis keys:
- `admin:agent:proactive:log` — health check results (list)
- `admin:agent:last_alert` — alert cooldown timestamps (hash)
- `admin:agent:kb` — knowledge base (hash, 90d TTL)
- `admin:agent:summary:<userId>` — conversation summaries (string, 30d TTL)

### Verifying memory context integration

The `buildMemoryContext()` function reads from `admin:agent:kb` and `admin:agent:summary:<uid>` to build a preamble appended to the system prompt on every turn. Verify the wiring by checking the bundle:

```bash
docker compose exec -T bot node -e "
const code = require('fs').readFileSync('/app/dist/index.cjs','utf8');
console.log(JSON.stringify({
  hasBuildMemoryContext: code.includes('buildMemoryContext'),
  hasMaybeSummarize: code.includes('maybeSummarize'),
  hasSummaryKeyPrefix: code.includes('admin:agent:summary:'),
}));
"
```

All should be `true`. If `buildMemoryContext` is missing, memory injection per turn won't work.

### Conversation auto-summarization

The summarization triggers at `SUMMARY_THRESHOLD = 24` messages. Without a Telegram client, this can only be verified at the bundle level (confirm `maybeSummarize` and `SUMMARY_THRESHOLD` are in the bundle). For a full end-to-end test, send 24+ messages through the admin Telegram bot and verify `admin:agent:summary:<uid>` appears in Redis.

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

## Testing event-driven announcements (e.g. maintenance toggle)

For features that listen to admin actions (Telegram inline button, dashboard `PUT`) and dispatch side-effects through process events (e.g. `bot:maintenance_ended` → `announceMaintenanceEnd(bot)`), the cheapest end-to-end verification path is to drive the dashboard PUT with the `DASHBOARD_SECRET` and watch logs + Redis state. No Telegram admin session needed.

### Pattern: dashboard PUT triggers async event

```bash
cd /home/ubuntu/book-bot
TOKEN=$(sudo docker compose exec -T bot printenv DASHBOARD_SECRET | tr -d '\r\n')

# Toggle ON
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":true}'

sleep 2

# Toggle OFF — this is the transition that fires the announcement
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'
```

Expected log sequence (within a few seconds):

```
[admin] maintenance OFF {"who":"dashboard"}
[maintenanceAnnounce] Announcing maintenance end {"targets":N,"known":K,"env":E}
[maintenanceAnnounce] Done {"sent":N,"failed":0,"removed":0,"total":N}
```

### Pattern: simulate "known group" without involving the user

The groupTracker (`bot:known_groups` Redis SET) is normally populated when a user posts in a group. To test the announcement path immediately, inject the admin's own bot DM chatId so the test message lands in the tester's own Telegram conversation with the bot:

```bash
ADMIN_DM_CHAT_ID='<positive-numeric-id>'   # e.g. the admin who runs /start
sudo docker compose exec -T redis redis-cli SADD bot:known_groups "$ADMIN_DM_CHAT_ID"
sudo docker compose exec -T redis redis-cli HSET bot:known_groups:meta "$ADMIN_DM_CHAT_ID" \
  '{"title":"Admin DM (synthetic test target)","lastSeen":0}'
```

Then run the toggle pattern above. The bot will deliver the announcement to that DM — verifiable with a single screenshot.

Alternatively, use `MAINTENANCE_ANNOUNCE_CHAT_IDS=<csv>` in the prod `.env` to pin permanent broadcast targets without touching Redis.

### Pattern: testing the 60-second NX lock for idempotence

The announcement uses a Redis NX lock (`maintenance:announce_lock`, TTL 60 s) to prevent duplicate announcements when multiple admin clients flip maintenance off in quick succession.

```bash
cd /home/ubuntu/book-bot
TOKEN=$(sudo docker compose exec -T bot printenv DASHBOARD_SECRET | tr -d '\r\n')

# 1. Turn maintenance on first.
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":true}'

sleep 1

# 2. Turn it off — this fires the first announcement.
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'

sleep 1

# 3. Turn on then off again (within 60 s).
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":true}'
sleep 1
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'
```

Expected: logs show exactly **one** `[maintenanceAnnounce] Announcing maintenance end` and one `[maintenanceAnnounce] Done`. The second OFF toggle within 60 s should **not** produce a second announcement.

After the test, confirm the lock expired:

```bash
sleep 61
docker compose exec -T redis redis-cli EXISTS maintenance:announce_lock
# Expected: 0 (lock expired)
```
