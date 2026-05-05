---
name: testing-book-bot
description: Test the Telegram book-bot production runtime, source quality, and deterministic backend cache/search behavior.
---

# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, deployment health, smart cached-PDF behavior, or admin-toggle/event-driven features such as maintenance-mode announcements.

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
[admin] 🔧maintenance OFF {"who":"dashboard"}
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

The routes.ts handler only emits the event on a real ON→OFF transition (it reads `wasActive` before the toggle). To force a *second* `announceMaintenanceEnd` call within the lock window, manually flip the flag back to ON via Redis between PUT calls:

```bash
# After the first OFF (which has already fired the announcement), the lock
# `maintenance:announce:lock` is set with TTL up to 60s.
sudo docker compose exec -T redis redis-cli TTL maintenance:announce:lock
sudo docker compose exec -T redis redis-cli SET flag:maintenance 1   # bypass routes.ts guard
curl -s -X PUT http://127.0.0.1:5000/api/admin/maintenance \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"active":false}'
```

Expected log line: `[maintenanceAnnounce] Skipping — another announcement in flight`. The lock value should be **unchanged** — proving `SET ... NX` refused to overwrite.

Clean up after testing:

```bash
sudo docker compose exec -T redis redis-cli DEL bot:known_groups bot:known_groups:meta maintenance:announce:lock flag:maintenance
```

### Critical gotcha: `docker compose restart` does NOT reload `.env`

If you add or change an env var in `/home/ubuntu/book-bot/.env`, a plain `docker compose restart bot` will **not** pick it up — the variable will appear empty inside the container. To reload env vars you must recreate the container:

```bash
cd /home/ubuntu/book-bot
sudo docker compose up -d bot
sleep 8
sudo docker compose exec -T bot printenv MY_NEW_ENV_VAR   # verify it loaded
```

## Reporting limitations

If no logged-in Telegram Web/test-chat session is available, explicitly mark literal chat UI testing as untested. Ask Ahmed to send messages while logs are monitored, or provide a test Telegram session, if full chat UI proof is required. For event-driven side-effect features (announcements, alerts), a single visual confirmation from the user is usually enough — the dashboard-PUT pattern above proves the dispatch logic without involving Telegram.
