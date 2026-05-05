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

### Synthetic-row insertion for cache fixes

For testing cache-hit re-validation (BUG-3) or `/purge_cache` (BUG-9), insert deterministic synthetic rows directly via the bot container's pg client. Two gotchas:

- The script must run **from `/app`** (where `node_modules/pg` lives) — running from `/tmp` fails with `Cannot find module 'pg'`.
- The container's loader uses CommonJS for arbitrary node scripts, so use `.cjs` (or use `require` syntax in a `.js` file) rather than ESM.

```bash
ssh -i $HOME/.ssh/devin_aws_ubuntu_key ubuntu@<production-host>
cat > /tmp/synth.cjs <<'EOF'
const { Client } = require("pg");
const c = new Client({ connectionString: process.env.DATABASE_URL });
(async () => {
  await c.connect();
  await c.query(
    `INSERT INTO cached_books
       (book_query, book_query_normalized, book_name, source_url, telegram_file_id, times_served)
     VALUES ($1,$2,$3,$4,$5,0)`,
    [
      "devin_test_synthetic",
      "devin_test_synthetic",                  // canonicalizeForCache(book_query)
      "كتاب لا علاقة له بالاستعلام",            // unrelated cached name → re-validation rejects
      "https://example.org/files/00001.pdf",  // example.org never serves real PDFs
      "BAQACAgIAaaaaaaaaaaaaaaaa",            // fake file_id (never used — re-validation aborts first)
    ],
  );
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
docker cp /tmp/synth.cjs book-bot-bot-1:/app/synth.cjs
docker exec book-bot-bot-1 sh -c 'cd /app && node synth.cjs && rm /app/synth.cjs'
```

Then ask Ahmed to send the matching query as a Telegram message; tail logs with `--since=<UTC TS>` to capture the response. Expected log markers for the cache-hit re-validation path:

- `[WARN] [cache] cache hit looked suspicious — falling through to full search`
- Redis counter `tel:cache:hit_revalidated_skip` increments by 1.

Always `DELETE FROM cached_books WHERE book_query LIKE 'devin_test_%'` at the end of the test run.

### `tsx` probe gotchas

When the probe needs `await` or relative `./server/bot/...` imports, the inline `npx tsx -e '...'` form trips on two issues. Use a small `.mjs` file inside the repo instead:

- **Module resolution** — `tsx` resolves relative imports against the script's directory. Running `npx tsx /tmp/probe.mjs` with `import "./server/bot/x.ts"` looks up `/tmp/server/bot/x.ts` and fails. Place the script inside `/home/ubuntu/book-bot/` and run from there.
- **Top-level `await`** — `npx tsx -e '...'` runs in cjs eval mode, which rejects top-level `await` (`Top-level await is currently not supported with the "cjs" output format`). Top-level `await` works fine inside a `.mjs` file.

```bash
cd /home/ubuntu/book-bot
cat > parser-probe.mjs <<'EOF'
import { parseBookName } from "./server/bot/bookNameParser.ts";
const cases = [
  { in: "لخصلي كتاب حوار مع صديقي الملحد", expect: "حوار مع صديقي الملحد" },
  { in: "تحميل كتاب الأغاني pdf",          expect: "الأغاني" },
];
let fail = 0;
for (const c of cases) {
  const got = await parseBookName(c.in);
  const ok  = got === c.expect;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + "  " + JSON.stringify(c.in) + " -> " + JSON.stringify(got));
}
process.exit(fail === 0 ? 0 : 1);
EOF
npx tsx parser-probe.mjs; CODE=$?
rm -f parser-probe.mjs
exit $CODE
```

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
