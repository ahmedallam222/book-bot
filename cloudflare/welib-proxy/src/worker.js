// ──────────────────────────────────────────────
// Welib CDN proxy — Cloudflare Worker
// ──────────────────────────────────────────────
// Why this exists: welib's CDN (welib-public.org and its s1/s2/...
// shards) blocks plain HTTP downloads from AWS / Google Cloud /
// other public-cloud egress IPs. The bot itself runs on AWS EC2
// (us-east-1, ASN AS16509) so any direct fetch of the signed
// download URL times out at 90s.
//
// This Worker is a thin proxy that:
//   1. Authenticates the caller with a shared bearer secret.
//   2. Validates the target host against an allowlist (welib-public.org
//      and trusted subdomains).
//   3. Streams the upstream response straight back (no buffering),
//      preserving Content-Type / Content-Length / Content-Disposition.
//
// Cloudflare's edge IPs are not on welib's blocklist, so the upstream
// fetch succeeds. The free Workers tier allows 100k requests/day which
// is far more than this bot will ever need (welib is one source out of
// 13 and only triggers when a welib URL ranks at the top of a search).
//
// Deployment: see ../README.md.
// ──────────────────────────────────────────────

const ALLOWED_HOSTS = [
  "welib-public.org",
  "s1.welib-public.org",
  "s2.welib-public.org",
  "s3.welib-public.org",
  "s4.welib-public.org",
  "s5.welib-public.org",
];

const PASSTHROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "etag",
  "last-modified",
  "accept-ranges",
];

function isAllowedHost(host) {
  const h = host.toLowerCase();
  if (ALLOWED_HOSTS.includes(h)) return true;
  // Allow any *.welib-public.org we did not explicitly enumerate.
  if (h.endsWith(".welib-public.org")) return true;
  return false;
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    // ── 1. Method gate ──
    if (request.method === "OPTIONS") {
      // CORS preflight (not strictly needed since the bot is server-side,
      // but harmless and helps if anyone wants to test from a browser).
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonError(405, "method_not_allowed");
    }

    // ── 2. Health endpoint ──
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // ── 3. Auth ──
    const secret = (env && env.WELIB_PROXY_SECRET) || "";
    if (!secret) {
      return jsonError(503, "worker_misconfigured: WELIB_PROXY_SECRET missing");
    }
    const auth = request.headers.get("authorization") || "";
    const expected = `Bearer ${secret}`;
    if (auth.length !== expected.length || auth !== expected) {
      // Constant-ish-time comparison: same-length string compare via ===
      // Real timing safety isn't critical (the secret is high-entropy),
      // but rejecting on any mismatch is enough.
      return jsonError(401, "unauthorized");
    }

    // ── 4. Target URL ──
    const target = url.searchParams.get("url");
    if (!target) {
      return jsonError(400, "missing_url_param");
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return jsonError(400, "invalid_url");
    }
    if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
      return jsonError(400, "unsupported_protocol");
    }
    if (!isAllowedHost(targetUrl.hostname)) {
      return jsonError(403, `host_not_allowed:${targetUrl.hostname}`);
    }

    // ── 5. Forward to upstream ──
    const upstreamHeaders = {
      "User-Agent":
        request.headers.get("user-agent") ||
        "Mozilla/5.0 (compatible; KholasaBot/1.0; +https://t.me/kholasaelktob_Bot)",
      "Accept":
        "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
      "Accept-Language": "ar,ar-SA;q=0.9,en;q=0.5",
    };

    let upstream;
    try {
      upstream = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch (e) {
      return jsonError(502, `upstream_fetch_failed:${(e && e.message) || e}`);
    }

    // ── 6. Stream response back ──
    const respHeaders = new Headers();
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    respHeaders.set("X-Welib-Proxy", "1");
    respHeaders.set("X-Welib-Proxy-Status", String(upstream.status));

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};
