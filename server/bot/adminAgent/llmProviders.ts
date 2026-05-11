// ══════════════════════════════════════════════════════════
// Admin Agent — dynamic LLM provider config
// ══════════════════════════════════════════════════════════
// Lets the admin hot-swap LLM providers (Cerebras/Groq/OpenAI/Anthropic/
// OpenRouter/…) from Telegram chat without redeploying.
//
// Storage: Redis hash `admin:agent:llm_providers` (field=id, value=JSON).
// Priority is encoded inside the value so a single HGETALL retrieves
// everything in one round-trip.
//
// Fallback: when the hash is empty (fresh install), DEFAULT_PROVIDERS
// is used. Defaults are derived from process.env so existing CEREBRAS_API_KEY
// / GROQ_API_KEY keep working without any migration.
//
// Keys are always masked in any return value (last 4 chars only).

import { redis } from "../redis.js";
import {
  CEREBRAS_API_KEY,
  GROQ_API_KEY,
  CLOUDFLARE_AI_ACCOUNT_ID,
  CLOUDFLARE_AI_API_TOKEN,
} from "../config.js";
import { L } from "../logger.js";

const HASH_KEY = "admin:agent:llm_providers";

export interface LLMProvider {
  /** Stable ID (e.g. "cerebras-gpt-oss-120b", "openai-gpt-4o-mini"). */
  id:       string;
  /** Display label (e.g. "Cerebras GPT-OSS 120B"). */
  name:     string;
  /** Base URL for the OpenAI-compatible API (no trailing slash, no /chat/completions). */
  baseUrl:  string;
  /** Model name to send in the `model` field. */
  model:    string;
  /** API key (stored encrypted-at-rest in Redis would be ideal; for now plain). */
  apiKey:   string;
  /** Lower number = higher priority. Defaults: cloudflare=1, cerebras=2, groq-oss=3, groq-llama=4. */
  priority: number;
  /** Set to false to keep the row but skip during dispatch. */
  enabled:  boolean;
  /** Last time the dispatcher used this provider successfully. */
  lastUsedAt?: number;
}

// ── built-in defaults ─────────────────────────────────────
// These exist so the admin agent works out-of-the-box with the
// existing CEREBRAS_API_KEY / GROQ_API_KEY env vars. The admin can
// overwrite or extend at runtime via tools.

/** Stable ID for the Cloudflare provider — referenced by the upsert
 * migration so existing Redis-seeded installs gain Cloudflare as
 * primary without resetting admin customisations. */
export const CLOUDFLARE_PROVIDER_ID = "cloudflare-gpt-oss-120b";

/** Build the Cloudflare provider object. Account id is interpolated
 * into the baseUrl because Cloudflare's OpenAI-compat endpoint is
 * scoped per-account: `/client/v4/accounts/{ACCOUNT_ID}/ai/v1`. */
function buildCloudflareProvider(priority: number): LLMProvider {
  return {
    id:       CLOUDFLARE_PROVIDER_ID,
    name:     "Cloudflare GPT-OSS 120B",
    baseUrl:  `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_AI_ACCOUNT_ID}/ai/v1`,
    model:    "@cf/openai/gpt-oss-120b",
    apiKey:   CLOUDFLARE_AI_API_TOKEN,
    priority,
    enabled:  true,
  };
}

export const DEFAULT_PROVIDERS: LLMProvider[] = [
  // Cloudflare Workers AI — primary. Same gpt-oss-120b model as Cerebras
  // but with much higher daily quota (~10k neurons free + cheap pay-as-you-go)
  // and supports function calling on the OpenAI-compat /v1/chat/completions
  // endpoint.
  buildCloudflareProvider(1),
  {
    id:       "cerebras-gpt-oss-120b",
    name:     "Cerebras GPT-OSS 120B",
    baseUrl:  "https://api.cerebras.ai/v1",
    model:    "gpt-oss-120b",
    apiKey:   CEREBRAS_API_KEY,
    priority: 2,
    enabled:  true,
  },
  {
    id:       "groq-gpt-oss-120b",
    name:     "Groq GPT-OSS 120B",
    baseUrl:  "https://api.groq.com/openai/v1",
    model:    "openai/gpt-oss-120b",
    apiKey:   GROQ_API_KEY,
    priority: 3,
    enabled:  true,
  },
  {
    id:       "groq-llama-3.3-70b",
    name:     "Groq Llama 3.3 70B",
    baseUrl:  "https://api.groq.com/openai/v1",
    model:    "llama-3.3-70b-versatile",
    apiKey:   GROQ_API_KEY,
    priority: 4,
    enabled:  true,
  },
];

// ── core CRUD ─────────────────────────────────────────────

/** Returns providers sorted by priority asc (1 first). Skips disabled / no-key. */
export async function loadProviders(): Promise<LLMProvider[]> {
  const all = await loadAllProvidersRaw();
  return all
    .filter(p => p.enabled && p.apiKey && p.apiKey.length > 5)
    .sort((a, b) => a.priority - b.priority);
}

/** Returns *all* providers (incl. disabled / missing key). For listing. */
export async function loadAllProvidersRaw(): Promise<LLMProvider[]> {
  const raw = await redis.hgetall(HASH_KEY).catch(() => ({} as Record<string, string>));
  if (raw && Object.keys(raw).length > 0) {
    const out: LLMProvider[] = [];
    for (const [id, json] of Object.entries(raw)) {
      try {
        const p = JSON.parse(json) as LLMProvider;
        if (p.id) out.push(p);
        else      out.push({ ...p, id });
      } catch { /* skip malformed row */ }
    }
    return out.sort((a, b) => a.priority - b.priority);
  }
  // Hash empty → use defaults (env-backed)
  return DEFAULT_PROVIDERS.filter(p => p.apiKey && p.apiKey.length > 5);
}

export async function setProvider(p: LLMProvider): Promise<void> {
  if (!p.id) throw new Error("provider id required");
  await redis.hset(HASH_KEY, p.id, JSON.stringify(p));
}

export async function removeProvider(id: string): Promise<boolean> {
  const n = await redis.hdel(HASH_KEY, id);
  return n > 0;
}

export async function getProvider(id: string): Promise<LLMProvider | null> {
  const raw = await redis.hget(HASH_KEY, id);
  if (!raw) return null;
  try { return JSON.parse(raw) as LLMProvider; } catch { return null; }
}

export async function markUsed(id: string): Promise<void> {
  // Fire-and-forget. Update `lastUsedAt` for observability — don't fail
  // dispatch if Redis blips.
  try {
    const p = await getProvider(id);
    if (p) {
      p.lastUsedAt = Date.now();
      await setProvider(p);
    }
  } catch { /* swallow */ }
}

// ── safety: mask keys before returning to LLM/admin ───────

export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function publicView(p: LLMProvider): Omit<LLMProvider, "apiKey"> & { apiKeyMasked: string } {
  const { apiKey, ...rest } = p;
  return { ...rest, apiKeyMasked: maskKey(apiKey) };
}

// ── seeding ───────────────────────────────────────────────

/**
 * On first boot, if the hash is empty but DEFAULT_PROVIDERS have keys,
 * write them to Redis so the admin sees them in `list_llm_providers`
 * and can edit/reorder. Idempotent — only seeds when hash is truly empty.
 */
export async function seedDefaultsIfEmpty(): Promise<{ seeded: number }> {
  const n = await redis.hlen(HASH_KEY).catch(() => 0);
  if (n > 0) return { seeded: 0 };
  let seeded = 0;
  for (const p of DEFAULT_PROVIDERS) {
    if (p.apiKey && p.apiKey.length > 5) {
      await setProvider(p);
      seeded++;
    }
  }
  return { seeded };
}

/**
 * Idempotent migration: ensures the Cloudflare provider exists in Redis
 * at priority 1 (or below the lowest existing priority, whichever is
 * smaller) so prod installs that were seeded before Cloudflare was a
 * default still gain it as primary on the next boot.
 *
 * Does NOT touch any existing Cloudflare row — if the admin already
 * configured one (any priority/key), this is a no-op so admin
 * customisations stick.
 *
 * Returns:
 *   added=true   — row was inserted (Cloudflare keys present, row was missing)
 *   skipped="no_keys"     — CF_ACCOUNT_ID or CF_API_TOKEN missing
 *   skipped="already_set" — admin already has a Cloudflare row
 */
export async function ensureCloudflarePrimary(): Promise<
  | { added: true;  priority: number }
  | { added: false; reason: "no_keys" | "already_set" }
> {
  if (!CLOUDFLARE_AI_ACCOUNT_ID || !CLOUDFLARE_AI_API_TOKEN) {
    return { added: false, reason: "no_keys" };
  }
  const existing = await getProvider(CLOUDFLARE_PROVIDER_ID).catch(() => null);
  if (existing) return { added: false, reason: "already_set" };

  // Pick priority = min(1, lowestExistingPriority - 1) so we always land
  // ahead of whatever the admin currently has, even if they manually
  // re-prioritised cerebras to 0.
  const all = await loadAllProvidersRaw().catch(() => [] as LLMProvider[]);
  const minExisting = all.reduce((m, p) => Math.min(m, p.priority), Number.POSITIVE_INFINITY);
  const priority = Number.isFinite(minExisting) ? Math.min(1, minExisting - 1) : 1;

  const provider = buildCloudflareProvider(priority);
  await setProvider(provider);
  L.info("adminAgent", `Cloudflare provider upserted at priority ${priority}`);
  return { added: true, priority };
}
