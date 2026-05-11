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
import { CEREBRAS_API_KEY, GROQ_API_KEY } from "../config.js";

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
  /** Lower number = higher priority. Defaults: cerebras=1, groq-oss=2, groq-llama=3. */
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

export const DEFAULT_PROVIDERS: LLMProvider[] = [
  {
    id:       "cerebras-gpt-oss-120b",
    name:     "Cerebras GPT-OSS 120B",
    baseUrl:  "https://api.cerebras.ai/v1",
    model:    "gpt-oss-120b",
    apiKey:   CEREBRAS_API_KEY,
    priority: 1,
    enabled:  true,
  },
  {
    id:       "groq-gpt-oss-120b",
    name:     "Groq GPT-OSS 120B",
    baseUrl:  "https://api.groq.com/openai/v1",
    model:    "openai/gpt-oss-120b",
    apiKey:   GROQ_API_KEY,
    priority: 2,
    enabled:  true,
  },
  {
    id:       "groq-llama-3.3-70b",
    name:     "Groq Llama 3.3 70B",
    baseUrl:  "https://api.groq.com/openai/v1",
    model:    "llama-3.3-70b-versatile",
    apiKey:   GROQ_API_KEY,
    priority: 3,
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
