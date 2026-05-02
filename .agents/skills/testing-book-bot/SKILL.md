# Testing book-bot production runtime

## When to use

Use this skill when testing the Telegram book-bot production deployment for search/result quality, Arabic UX copy, source-health analytics, source auto-disable, or deployment health.

## Devin Secrets Needed

- `FIRECRAWL_API_KEY` — needed for local/dev Firecrawl-backed searches if running the bot outside production.
- `AWS_UBUNTU_SSH_PRIVATE_KEY` or an equivalent SSH key provisioned at `$HOME/.ssh/devin_aws_ubuntu_key` — needed to access the production Ubuntu server.

Do not print production `.env` values. Production runtime secrets live in `/home/ubuntu/book-bot/.env` on the server.

## Production environment

- AWS server: `ubuntu@54.196.55.152`, SSH port 22.
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
