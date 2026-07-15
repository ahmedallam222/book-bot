// ══════════════════════════════════════════════
// Telegram-channels fallback search.
//
// When welib + the Arabic-source pool both come up empty, we have one
// last lever: a gramjs userbot (separate phone-number account, NOT the
// bot) that is a *member* of ~30–200 public Arabic book channels and
// can call MTProto's `messages.searchGlobal` with a document filter.
// A single API call returns up to ~50 PDFs from across every channel
// the userbot is in, ranked by Telegram's own relevance heuristics.
//
// Why a userbot (not the regular Bot API):
//   The Bot API can't `searchGlobal` and can't join arbitrary public
//   channels without an admin invite. A userbot is a real account
//   logged in via StringSession — same access surface as a normal
//   Telegram client. The user owns the account (a dedicated 2nd
//   Telegram account, isolated from the admin account so a ban
//   doesn't cascade).
//
// Trust gates downstream:
//   This module returns *candidates*. Every candidate flows through
//   the same downstream pipeline as welib hits: pdfValidator (with
//   Llama prefilter #140 + Mistral fallback), translation-aware
//   title-gate (#133), per-reason rejection taxonomy (#137). Zero
//   special-casing — a Telegram PDF gets the same trust treatment as
//   a welib PDF.
//
// Telemetry (Redis counters, namespaced):
//   tel:tg:searched          // any call to searchTelegramChannels
//   tel:tg:search_cache_hit  // returned cached results
//   tel:tg:connect_failed    // gramjs failed to connect (no session?)
//   tel:tg:found             // ≥1 candidate returned
//   tel:tg:no_results        // 0 candidates after filter
//   tel:tg:search_timeout    // MTProto call exceeded SEARCH_TIMEOUT_MS
//   tel:tg:flood_wait        // Telegram rate-limited us
//   tel:tg:search_error      // other gramjs/network error
//   tel:tg:downloaded        // a candidate was successfully pulled to disk
//   tel:tg:download_error    // pull-to-disk failed
//
// Resilience:
//   Every failure mode is swallowed and returns `[]` — Telegram is the
//   last fallback, never a hard dependency. The bot keeps working
//   even if the userbot is logged out, banned, or the session is
//   revoked. The counters surface the failure mode to the dashboard
//   without crashing user-facing flows.
// ══════════════════════════════════════════════

import { L } from "./logger.js";
import { MAX_PDF_SIZE } from "./config.js";
import { redis } from "./redis.js";

const TG_API_ID   = Number(process.env.TELEGRAM_API_ID) || 0;
const TG_API_HASH = (process.env.TELEGRAM_API_HASH || "").trim();
const TG_SESSION  = (process.env.TELEGRAM_USERBOT_SESSION || "").trim();

export const TG_FALLBACK_ENABLED =
  TG_API_ID > 0 && TG_API_HASH.length > 0 && TG_SESSION.length > 0;

// ── Tunables ──────────────────────────────────
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_LIMIT      = 30;       // top-N from messages.searchGlobal
const CACHE_TTL_HIT_SEC = 24 * 3600; // 24 h for non-empty result
const CACHE_TTL_MISS_SEC = 600;      // 10 min for empty result
const MIN_QUERY_LEN     = 3;

// ── Types ────────────────────────────────────
export interface TelegramSearchResult {
  channelId:       string;   // raw channel id (e.g. "1234567890")
  channelTitle:    string;   // display name for logs / captions
  channelUsername: string;   // "" if private/numeric-only
  msgId:           number;   // message id within channel
  fileId:          string;   // gramjs Document.id (informational)
  fileName:        string;   // best-effort filename
  fileSize:        number;   // bytes (0 if unknown)
  mimeType:        string;   // always "application/pdf" here
  caption:         string;   // free-text caption, may contain title
  date:            number;   // unix seconds
  url:             string;   // synthetic: t.me/<username>/<msgId> or tg://msg/<id>/<msgId>
}

// ── Client singleton ─────────────────────────
// Loaded lazily on first call. We keep one persistent MTProto
// connection per process — gramjs handles auto-reconnect internally
// (connectionRetries: 5). If construction fails (bad session,
// network), we cache the null result for a short window so we don't
// spin retrying on every search.

type GramJsClient = unknown; // typed as `any` at the use-site to avoid leaking the gramjs surface

let client:          GramJsClient | null = null;
let connectPromise:  Promise<GramJsClient | null> | null = null;
let lastConnectFail: number = 0;
const CONNECT_BACKOFF_MS = 60_000; // retry connect at most once per minute

async function getClient(): Promise<GramJsClient | null> {
  if (!TG_FALLBACK_ENABLED) return null;
  if (client) return client;
  if (connectPromise) return connectPromise;
  if (Date.now() - lastConnectFail < CONNECT_BACKOFF_MS) return null;

  connectPromise = (async () => {
    try {
      // Dynamic import keeps `telegram` (gramjs) out of the cold path
      // for installs that don't enable the fallback (TG_FALLBACK_ENABLED=false).
      const { TelegramClient } = await import("telegram");
      const { StringSession } = await import("telegram/sessions/index.js");

      const session = new StringSession(TG_SESSION);
      const c = new TelegramClient(session, TG_API_ID, TG_API_HASH, {
        connectionRetries: 5,
        // gramjs default is verbose; raise to suppress connection-level
        // INFO chatter in our logs. WARN+ still surfaces (auth failures,
        // flood waits, etc.).
        baseLogger: { info: () => {}, warn: console.warn, error: console.error, debug: () => {} } as never,
      });
      await c.connect();
      client = c;
      L.info("tg", "userbot connected");
      return client;
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e).slice(0, 120);
      L.warn("tg", `userbot connect failed: ${msg}`);
      redis.incr("tel:tg:connect_failed").catch(() => {});
      lastConnectFail = Date.now();
      connectPromise = null;
      return null;
    }
  })();
  return connectPromise;
}

// ── Search lock ──────────────────────────────
// Serialize searches to avoid hitting Telegram's per-account flood
// limits. messages.searchGlobal is cheap (1 RPC) but the worst case
// is dozens of users all asking distinct queries within the same
// second; without a lock we'd fire dozens of concurrent RPCs and
// Telegram replies with FLOOD_WAIT for several minutes.

let searchInFlight = false;
const searchQueue: Array<() => void> = [];

async function withSearchLock<T>(fn: () => Promise<T>): Promise<T> {
  if (searchInFlight) {
    await new Promise<void>((resolve) => searchQueue.push(resolve));
  }
  searchInFlight = true;
  try {
    return await fn();
  } finally {
    searchInFlight = false;
    const next = searchQueue.shift();
    if (next) next();
  }
}

// ── Helpers ──────────────────────────────────

function cacheKey(query: string): string {
  return `tg:search:${query.toLowerCase().normalize("NFKC").slice(0, 120)}`;
}

function extractFilename(doc: { attributes?: Array<Record<string, unknown>> }): string {
  for (const attr of doc.attributes || []) {
    // gramjs DocumentAttributeFilename
    const name = attr["fileName"];
    if (typeof name === "string" && name) return name;
  }
  return "";
}

interface RawPeerId {
  channelId?: unknown;
  userId?:    unknown;
  chatId?:    unknown;
}

function peerIdToString(peerId: RawPeerId | undefined): string {
  if (!peerId) return "";
  const id = peerId.channelId ?? peerId.userId ?? peerId.chatId;
  if (id === undefined || id === null) return "";
  // gramjs returns BigInt — normalize to decimal string
  return typeof id === "bigint" ? id.toString() : String(id);
}

function buildSyntheticUrl(channelUsername: string, channelIdRaw: string, msgId: number): string {
  if (channelUsername) return `https://t.me/${channelUsername}/${msgId}`;
  return `tg://msg/${channelIdRaw}/${msgId}`;
}

export function isTelegramUrl(url: string): boolean {
  if (!url) return false;
  return /^(?:https?:\/\/)?t\.me\/[A-Za-z0-9_]+\/\d+/.test(url) ||
         url.startsWith("tg://msg/");
}

export function parseTelegramUrl(
  url: string,
): { channelRef: string; msgId: number } | null {
  if (!url) return null;
  const pub = url.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)\/(\d+)/);
  if (pub) return { channelRef: pub[1], msgId: Number(pub[2]) };
  const tg = url.match(/^tg:\/\/msg\/([-\d]+)\/(\d+)/);
  if (tg) return { channelRef: tg[1], msgId: Number(tg[2]) };
  return null;
}

// ── Public API: searchTelegramChannels ───────

export async function searchTelegramChannels(
  query: string,
): Promise<TelegramSearchResult[]> {
  if (!TG_FALLBACK_ENABLED) return [];
  const q = (query || "").trim();
  if (q.length < MIN_QUERY_LEN) return [];

  // 1. Redis cache check
  const key = cacheKey(q);
  try {
    const cached = await redis.get(key);
    if (cached) {
      redis.incr("tel:tg:search_cache_hit").catch(() => {});
      try {
        return JSON.parse(cached) as TelegramSearchResult[];
      } catch { /* malformed cache → fall through */ }
    }
  } catch { /* redis down → fall through */ }

  // 2. Bring up client (cheap if already connected)
  redis.incr("tel:tg:searched").catch(() => {});
  const c = (await getClient()) as
    | (Record<string, unknown> & { invoke: (req: unknown) => Promise<unknown> })
    | null;
  if (!c) return [];

  // 3. Issue searchGlobal with document filter
  const t0 = Date.now();
  try {
    // Defer the gramjs Api import — same lazy strategy as the client
    const { Api } = await import("telegram");

    const result = (await withSearchLock(async () => {
      return await Promise.race([
        c.invoke(
          new Api.messages.SearchGlobal({
            q,
            filter:     new Api.InputMessagesFilterDocument(),
            minDate:    0,
            maxDate:    0,
            offsetRate: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId:   0,
            limit:      SEARCH_LIMIT,
          }),
        ),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("SEARCH_TIMEOUT")), SEARCH_TIMEOUT_MS),
        ),
      ]);
    })) as { messages?: unknown[]; chats?: unknown[] };

    const messages = result.messages || [];
    const chats    = result.chats    || [];

    // Build a lookup so we can attach channel title / username
    // (messages.searchGlobal returns chat refs in a parallel array).
    const chatById = new Map<string, { title?: string; username?: string }>();
    for (const raw of chats) {
      const ch = raw as { id?: unknown; title?: string; username?: string };
      const id = typeof ch.id === "bigint" ? ch.id.toString() : String(ch.id);
      if (id) chatById.set(id, { title: ch.title, username: ch.username });
    }

    const out: TelegramSearchResult[] = [];
    for (const raw of messages) {
      const msg = raw as {
        id?:      number;
        date?:    number;
        message?: string;
        peerId?:  RawPeerId;
        media?:   { document?: {
          id?:        unknown;
          mimeType?:  string;
          size?:      unknown;
          attributes?: Array<Record<string, unknown>>;
        } };
      };
      const doc = msg.media?.document;
      if (!doc || doc.mimeType !== "application/pdf") continue;

      const channelIdRaw = peerIdToString(msg.peerId);
      const chat = chatById.get(channelIdRaw) || {};
      const username = chat.username || "";
      const title    = chat.title || username || channelIdRaw;

      const fname = extractFilename(doc) || `tg_${msg.id ?? 0}.pdf`;
      const size  = typeof doc.size === "bigint" ? Number(doc.size) : Number(doc.size || 0);

      // Bot API cannot re-upload files > ~50MB. Skip at search time so we
      // never burn a download attempt on a guaranteed 413.
      if (size > MAX_PDF_SIZE) {
        redis.incr("tel:tg:skipped_too_large").catch(() => {});
        continue;
      }

      out.push({
        channelId:       channelIdRaw,
        channelTitle:    String(title).slice(0, 120),
        channelUsername: username,
        msgId:           Number(msg.id || 0),
        fileId:          typeof doc.id === "bigint" ? doc.id.toString() : String(doc.id ?? ""),
        fileName:        fname.slice(0, 200),
        fileSize:        size,
        mimeType:        doc.mimeType,
        caption:         (msg.message || "").slice(0, 500),
        date:            Number(msg.date || 0),
        url:             buildSyntheticUrl(username, channelIdRaw, Number(msg.id || 0)),
      });
    }

    const tookMs = Date.now() - t0;
    L.info("tg", "searchGlobal", {
      q:     q.slice(0, 60),
      found: out.length,
      tookMs,
    });

    // Prefer smaller PDFs first — bot upload cap is ~50MB; smaller files
    // validate+send faster and leave room for more candidates in the job budget.
    out.sort((a, b) => {
      const sa = a.fileSize > 0 ? a.fileSize : Number.MAX_SAFE_INTEGER;
      const sb = b.fileSize > 0 ? b.fileSize : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });

    if (out.length > 0) {
      redis.incr("tel:tg:found").catch(() => {});
      redis.setex(key, CACHE_TTL_HIT_SEC, JSON.stringify(out)).catch(() => {});
    } else {
      redis.incr("tel:tg:no_results").catch(() => {});
      redis.setex(key, CACHE_TTL_MISS_SEC, "[]").catch(() => {});
    }
    return out;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || e).slice(0, 120);
    if (msg.includes("TIMEOUT")) {
      redis.incr("tel:tg:search_timeout").catch(() => {});
    } else if (/FLOOD_WAIT/.test(msg)) {
      redis.incr("tel:tg:flood_wait").catch(() => {});
    } else {
      redis.incr("tel:tg:search_error").catch(() => {});
    }
    L.warn("tg", `searchGlobal failed: ${msg}`, { q: q.slice(0, 60) });
    return [];
  }
}

// ── Public API: downloadTelegramFile ─────────
// Pull a document by channel + msgId to a local path. download.ts will
// then validate the file (magic-bytes + pdfValidator) and uploadDoc
// to the user via the bot's existing send-document path.

export async function downloadTelegramFile(
  channelRef: string,
  msgId:      number,
  destPath:   string,
): Promise<{ ok: boolean; size?: number; error?: string }> {
  if (!TG_FALLBACK_ENABLED) return { ok: false, error: "tg_disabled" };
  const c = (await getClient()) as
    | (Record<string, unknown> & {
        getMessages: (peer: unknown, opts: { ids: number[] }) => Promise<unknown[]>;
        downloadMedia: (msg: unknown, opts: { outputFile: string }) => Promise<unknown>;
      })
    | null;
  if (!c) return { ok: false, error: "tg_not_connected" };

  try {
    // channelRef can be:
    //   - username ("nourbook")  → gramjs resolves directly
    //   - numeric id  ("1234")    → cast to BigInt for the peer
    let peer: string | bigint = channelRef;
    if (/^-?\d+$/.test(channelRef)) {
      try { peer = BigInt(channelRef); } catch { peer = channelRef; }
    }

    const messages = await c.getMessages(peer as unknown, { ids: [msgId] });
    const m = messages?.[0] as {
      media?: {
        document?: { size?: unknown; mimeType?: string };
      };
    } | undefined;
    if (!m || !m.media) {
      redis.incr("tel:tg:download_error").catch(() => {});
      return { ok: false, error: "no_media" };
    }

    // Guard before CDN pull: channel files can be >50MB while Bot API
    // sendDocument hard-fails with 413. Refuse early to save bandwidth.
    const declared = m.media.document?.size;
    const declaredSize = typeof declared === "bigint" ? Number(declared) : Number(declared || 0);
    if (declaredSize > MAX_PDF_SIZE) {
      redis.incr("tel:tg:skipped_too_large").catch(() => {});
      return { ok: false, error: `too_large:${(declaredSize / 1024 / 1024).toFixed(1)}MB` };
    }

    const buf = (await c.downloadMedia(m, { outputFile: destPath })) as
      | { byteLength?: number }
      | null;
    redis.incr("tel:tg:downloaded").catch(() => {});
    return { ok: true, size: typeof buf?.byteLength === "number" ? buf.byteLength : 0 };
  } catch (e: unknown) {
    redis.incr("tel:tg:download_error").catch(() => {});
    const msg = String((e as Error)?.message || e).slice(0, 120);
    L.warn("tg", `download failed: ${msg}`, { channel: channelRef.slice(0, 40), msgId });
    return { ok: false, error: msg };
  }
}
