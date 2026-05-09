# Welib CDN proxy (Cloudflare Worker)

Welib's CDN (`welib-public.org` and its `s1/s2/.../sN` shards) blocks
HTTP downloads from public-cloud egress IPs (AWS, GCP, Azure). Since
this bot runs on AWS EC2 (us-east-1, ASN AS16509), every direct fetch
of a welib signed URL times out at 90 seconds.

This Worker is a thin authenticated proxy. The bot sends:

```
GET https://welib-proxy.<your-subdomain>.workers.dev/?url=<encoded-signed-url>
Authorization: Bearer <WELIB_PROXY_SECRET>
```

The Worker verifies the bearer secret, validates the target host
against an allowlist (only `welib-public.org` and its subdomains), then
streams the upstream response straight back. Cloudflare's edge IPs are
not on welib's blocklist, so the upstream fetch succeeds.

## Free tier capacity

- Workers Free: 100,000 requests/day, 10 ms CPU/request.
- This proxy is network-bound (not CPU-bound) so the CPU cap is fine.
- The bot only routes welib downloads through it, which is one source
  out of 13. Real traffic is well under 1,000/day.

## One-time setup

You need a Cloudflare account (free is fine).

```bash
# 1. Install Wrangler globally (or use npx).
npm install -g wrangler@^3.78.0

# 2. Log in. Opens a browser — pick the right account.
wrangler login

# 3. From this directory, deploy.
cd cloudflare/welib-proxy
npm install         # downloads wrangler locally
wrangler deploy     # builds + uploads worker.js
```

The first `wrangler deploy` will print the Worker's public URL, e.g.
`https://welib-proxy.YOUR-SUBDOMAIN.workers.dev`. **Save this URL.**

## Set the shared secret

Generate a 32-byte random string and store it as a Cloudflare secret:

```bash
openssl rand -hex 32 | wrangler secret put WELIB_PROXY_SECRET
```

(Copy the same value — you will paste it into the bot's `.env` in the
next step.)

## Verify the worker

```bash
# Health endpoint — no auth required:
curl https://welib-proxy.YOUR-SUBDOMAIN.workers.dev/health
# → {"ok":true,"ts":...}

# Auth gate — should be 401:
curl -i "https://welib-proxy.YOUR-SUBDOMAIN.workers.dev/?url=https://example.com"
# → 401 unauthorized

# Host gate — should be 403:
curl -i -H "Authorization: Bearer YOUR-SECRET" \
  "https://welib-proxy.YOUR-SUBDOMAIN.workers.dev/?url=https://example.com"
# → 403 host_not_allowed:example.com

# Real test — should stream a tiny PDF (or 404 if hash is stale):
curl -i -H "Authorization: Bearer YOUR-SECRET" \
  "https://welib-proxy.YOUR-SUBDOMAIN.workers.dev/?url=https%3A%2F%2Fs2.welib-public.org%2F.../some.pdf" \
  -o /tmp/test.pdf
file /tmp/test.pdf  # → "PDF document, version X.Y"
```

## Wire the bot to the proxy

On the production server, edit `/home/ubuntu/book-bot/.env` and add:

```
WELIB_PROXY_URL=https://welib-proxy.YOUR-SUBDOMAIN.workers.dev/
WELIB_PROXY_SECRET=<the-same-secret-you-stored-via-wrangler>
```

Then restart the bot:

```bash
cd /home/ubuntu/book-bot
docker compose up -d --force-recreate bot
docker compose logs -f --since 1m bot | grep welib
```

When `WELIB_PROXY_URL` and `WELIB_PROXY_SECRET` are both set, the
bot routes every welib signed-URL fetch through the Worker. If either
is missing, the bot falls back to the direct-fetch path (which will
keep timing out on EC2 — by design, no silent regression).

## Updating the worker

Push a code change in `src/worker.js`, then:

```bash
cd cloudflare/welib-proxy
wrangler deploy
```

That's the entire deploy. Worker version is replaced atomically.

## Removing the worker

```bash
wrangler delete
```

This is reversible — you can `wrangler deploy` again later.

## Logs

```bash
wrangler tail
```

Streams real-time `console.log` output from the deployed Worker. The
proxy itself logs nothing by default (privacy + speed); add logs in
`worker.js` if you need to debug.

## Cost / limits

| Limit                  | Value                          |
| ---------------------- | ------------------------------ |
| Requests/day (Free)    | 100,000                        |
| CPU per request        | 10 ms                          |
| Outbound bandwidth     | unmetered                      |
| Subrequests/request    | 50                             |

If usage ever spikes past Free, the upgrade is $5/month for Workers
Paid which lifts everything to "effectively unlimited" for this scale
of traffic.
