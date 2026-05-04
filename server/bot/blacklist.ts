import { redis } from "./redis.js";
import { L }      from "./logger.js";
import { BLACKLIST_THRESHOLD } from "./config.js";

// ══════════════════════════════════════════════
// BLACKLIST — حجب URLs الفاشلة
// ══════════════════════════════════════════════
//
// التصميم القديم: عضوية في Set `bl:blocked` بدون TTL، + counter
// `bl:fail:{url}` بـ TTL 7 أيام. كان مقترحاً أن "3 نجاحات متتالية"
// (`recordUrlSuccess` → BL_SUCCESS_KEY) تخرج الـ URL من القائمة، لكن
// `downloadAndSend` يفحص `isBlacklisted` ويعود مبكِّراً قبل أي fetch
// → `recordUrlSuccess` لا يُستدعى أبداً للـ URLs المحجوبة. نتيجة:
//   - عضوية الـ Set تتراكم للأبد.
//   - منطق "نجاحات متتالية" dead code فعلياً.
//
// التصميم الجديد (FIX-BL-EXIT):
//   - `bl:blocked:{url}` كـ string key مع EX = BL_BLOCK_TTL_SEC.
//     الـ key يختفي تلقائياً → فرصة جديدة بعد فترة probation.
//   - `bl:fail:{url}` يُحتفظ به كـ counter ينتهي بنفس TTL لتفادي
//     re-block فوري.
//   - `isBlacklisted` يكتفي بـ EXISTS على الـ key (O(1)).
//   - `recordUrlSuccess` يحذف الـ block + counter مباشرة (أي نجاح
//     يكفي بعد probation — لا حاجة لمنطق success-streak معقد).

const BL_FAIL_KEY    = (url: string) => `bl:fail:${url}`;
const BL_BLOCK_KEY   = (url: string) => `bl:blocked:${url}`;
const BL_INDEX_SET   = "bl:blocked:index"; // للـ stats فقط؛ يُنظَّف lazily
const BL_FAIL_TTL_SEC  = 7  * 24 * 3600;   // counter window — 7 أيام
const BL_BLOCK_TTL_SEC = 14 * 24 * 3600;   // block period — 14 يوماً ثم إعادة محاولة تلقائية

export async function isBlacklisted(url: string): Promise<boolean> {
  try {
    return (await redis.exists(BL_BLOCK_KEY(url))) === 1;
  } catch {
    return false;
  }
}

// Lua: INCR + EXPIRE atomically. القديم كان عمليتين منفصلتين، فلو
// انقطع الاتصال أو crashed بين السطرين كان مفتاح الـ counter يبقى بدون
// TTL إلى الأبد ويظل المستخدم محظورا عبر الزمن.
const incrWithTtlLua = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export async function recordUrlFailure(url: string): Promise<void> {
  try {
    const key   = BL_FAIL_KEY(url);
    const count = await (redis as unknown as { eval: (s: string, n: number, ...a: string[]) => Promise<number> })
      .eval(incrWithTtlLua, 1, key, String(BL_FAIL_TTL_SEC));
    if (count >= BLACKLIST_THRESHOLD) {
      // FIX-BL-EXIT: استبدال SADD بـ SET ... EX → الحجب ينتهي تلقائياً.
      // BL_INDEX_SET يُحدَّث للـ stats فقط (lazy cleanup عبر isBlacklisted
      // أثناء العد في blacklistStats).
      await redis.pipeline()
        .set(BL_BLOCK_KEY(url), "1", "EX", BL_BLOCK_TTL_SEC)
        .sadd(BL_INDEX_SET, url)
        .exec();
      L.warn("blacklist", `URL blacklisted after ${count} failures (will auto-clear in ${BL_BLOCK_TTL_SEC / 86400}d)`, {
        url: url.slice(0, 80),
      });
    }
  } catch {}
}

export async function recordUrlSuccess(url: string): Promise<void> {
  try {
    // FIX-BL-EXIT: نمسح كلاهما (counter + block) عند أي نجاح. منطق
    // "3 نجاحات متتالية" القديم كان dead code (downloadAndSend يعود مبكِّراً
    // عند block). الآن: success path نظيف، probation period تحدده الـ TTL.
    await redis.pipeline()
      .del(BL_FAIL_KEY(url))
      .del(BL_BLOCK_KEY(url))
      .srem(BL_INDEX_SET, url)
      .exec();
  } catch {}
}

export async function blacklistUrlDirect(url: string): Promise<void> {
  try {
    await redis.pipeline()
      .set(BL_BLOCK_KEY(url), "1", "EX", BL_BLOCK_TTL_SEC)
      .sadd(BL_INDEX_SET, url)
      .exec();
    L.warn("blacklist", `URL manually blacklisted`, { url: url.slice(0, 80) });
  } catch {}
}

export async function blacklistStats(): Promise<{ total: number; active: number }> {
  try {
    // الـ index Set قد يحتوي روابط انتهى block TTL لها → نتحقق ونحسب الحقيقي.
    // SCAN على الـ Set رخيص (≤ بضعة آلاف عضو في الإنتاج).
    const indexed = await redis.smembers(BL_INDEX_SET);
    if (indexed.length === 0) return { total: 0, active: 0 };

    const pipe = redis.pipeline();
    for (const url of indexed) pipe.exists(BL_BLOCK_KEY(url));
    const res = await pipe.exec();

    let active = 0;
    const stale: string[] = [];
    for (let i = 0; i < indexed.length; i++) {
      const exists = (res?.[i]?.[1] as number) === 1;
      if (exists) active++;
      else        stale.push(indexed[i]);
    }

    // lazy cleanup للـ index — fire-and-forget
    if (stale.length > 0) {
      redis.srem(BL_INDEX_SET, ...stale).catch(() => {});
    }

    return { total: indexed.length, active };
  } catch {
    return { total: 0, active: 0 };
  }
}

export async function clearBlacklist(): Promise<void> {
  try {
    const indexed = await redis.smembers(BL_INDEX_SET);
    if (indexed.length > 0) {
      const pipe = redis.pipeline();
      for (const url of indexed) {
        pipe.del(BL_BLOCK_KEY(url));
        pipe.del(BL_FAIL_KEY(url));
      }
      pipe.del(BL_INDEX_SET);
      await pipe.exec();
    }
    L.adminAction("system", "blacklist cleared");
  } catch (e) {
    L.warn("blacklist", `clearBlacklist error: ${String(e).slice(0, 80)}`);
  }
}
