#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// MIGRATION: Re-canonicalize stats:top_books leaderboard
// ═══════════════════════════════════════════════════════════════════
//
// قبل الإصلاح: البوت كان يخزّن الـ user query الخام في `stats:top_books`
// (sorted set). فالنتيجة: نفس الكتاب بصيغ مختلفة (ى/ي، ة/ه، أ/إ/آ،
// مع/بدون اسم المؤلف، علامات ترقيم لاصقة) كان entries مختلفة.
//
// السكريبت ده بيعمل:
//   1. يقرأ كل الـ entries من `stats:top_books` بـ scores
//   2. يحسب canonicalBookKey لكل واحد
//   3. يجمع الـ scores اللي عندها نفس الـ canonical key
//   4. يكتب الـ aggregated data في key مؤقتة، ثم يستبدل الأصلية
//   5. يكتب أحدث display name لكل canonical key في
//      `stats:top_books_display`
//
// كيفية التشغيل (من داخل docker container):
//   docker exec book-bot-bot-1 node scripts/migrate-top-books.mjs
//
// أو dry-run:
//   docker exec book-bot-bot-1 node scripts/migrate-top-books.mjs --dry
//
// ═══════════════════════════════════════════════════════════════════

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const DRY_RUN = process.argv.includes("--dry") || process.argv.includes("-n");

// نسخة محلية مبسّطة من normalizeArabic + canonicalizeForCache + canonicalBookKey
// (نتجنّب الاعتماد على الـ ts build).
function normalizeArabic(text) {
  return text
    .replace(/[\u064B-\u065F\u0670]/g, "")  // تشكيل
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ/إ/آ/ٱ → ا
    .replace(/\u0629/g, "\u0647")             // ة → ه
    .replace(/\u0649/g, "\u064A")             // ى → ي
    .replace(/\u0624/g, "\u0648")             // ؤ → و
    .replace(/\u0626/g, "\u064A")             // ئ → ي
    .replace(/[\u0660-\u0669]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))
    .trim()
    .toLowerCase();
}

function normalizeForCache(text) {
  return normalizeArabic(text).replace(/\s+/g, " ").trim();
}

// نفس قائمة CLEAN_LEADING في text.ts — لو حدّثت لازم تنسخها هنا
const CLEAN_LEADING = /^(?:كتاب|رواية|روايه|قصة|قصه|كتيب|كتب|روايات|قصص|ديوان|تحميل|تنزيل|حمّل|نزّل|اقرأ|قراءة|لخصلي|لخّصلي|لخّص\s+لي|لخص\s+لي|لخّص|لخص|ملخص|ملخّص|مُلخّص|تلخيص|اختصرلي|اختصر\s+لي|اختصر|ابغي|ابغى|ابي|أبي|اريد|أريد|ممكن|اجيب|أجيب|اطلب|أطلب)\s+/i;

const CLEAN_ANYWHERE = [
  "pdf", "PDF", "ebook", "epub",
  "مجانا", "مجانًا", "مجاناً", "مجاني", "مجانية", "free",
  "كامل", "كاملة", "كامله", "نسخة", "نسخه",
  "اسمه", "اسمها", "يسمى", "تسمى",
];

function cleanSearchQuery(query) {
  let cleaned = query.trim();
  let prev;
  do {
    prev = cleaned;
    const withoutLeading = cleaned.replace(CLEAN_LEADING, "").trim();
    if (withoutLeading.length >= 2) cleaned = withoutLeading;
    else break;
  } while (cleaned !== prev);
  for (const word of CLEAN_ANYWHERE) {
    const re = new RegExp(`(^|\\s)${word}(\\s|$)`, "gi");
    cleaned = cleaned.replace(re, " ");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length < 2) return query.trim();
  return cleaned;
}

function canonicalizeForCache(text) {
  return normalizeForCache(cleanSearchQuery(text));
}

function canonicalBookKey(text) {
  if (!text) return "";
  let key = canonicalizeForCache(text);
  key = key.replace(/^[\s.,;:!?'"`«»—–\-ـ]+|[\s.,;:!?'"`«»—–\-ـ]+$/g, "");
  key = key.replace(/\s+/g, " ").trim();
  if (key.length > 100) key = key.slice(0, 100).trim();
  return key;
}

// كلمات شكوى — لو الـ entry فيها واحدة منهم نتجاهلها
const COMPLAINT_PATTERNS = [
  /ليس\s+الكتاب\s+المطلوب/i,
  /مش\s+(?:هو|الكتاب|دا|دي|ده|اللي)/i,
  /غلط\s+الكتاب|كتاب\s+غلط/i,
  /خطأ|خاطئ/i,
  /\bwrong\s+book\b/i,
  /\bnot\s+the\s+book\b/i,
];

function isComplaintQuery(text) {
  if (!text) return false;
  return COMPLAINT_PATTERNS.some((re) => re.test(text));
}

const KEY = "stats:top_books";
const DISPLAY_KEY = "stats:top_books_display";
const TMP_KEY = "stats:top_books:_migrating";

async function main() {
  const redis = new Redis(REDIS_URL);
  console.log(`Connected to Redis. Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  const all = await redis.zrevrange(KEY, 0, -1, "WITHSCORES");
  console.log(`Read ${all.length / 2} entries from ${KEY}`);

  if (all.length === 0) {
    console.log("No entries to migrate. Exiting.");
    await redis.quit();
    return;
  }

  // canonical → { score, displays: Set<string> }
  const merged = new Map();
  let dropped = 0;

  for (let i = 0; i < all.length; i += 2) {
    const member = all[i];
    const score = parseFloat(all[i + 1]);
    if (!Number.isFinite(score)) continue;

    if (isComplaintQuery(member)) {
      dropped++;
      console.log(`  ✗ DROPPED (complaint): "${member.slice(0, 60)}" (score=${score})`);
      continue;
    }

    const key = canonicalBookKey(member);
    if (!key) {
      dropped++;
      console.log(`  ✗ DROPPED (empty key): "${member.slice(0, 60)}" (score=${score})`);
      continue;
    }

    let entry = merged.get(key);
    if (!entry) {
      entry = { score: 0, displays: [], maxScore: 0 };
      merged.set(key, entry);
    }
    entry.score += score;
    // نفضّل الـ display اللي عنده أعلى score الفردي (أكثر مستخدمين كتبوه)
    // ولو tied، نأخذ الأطول (يحوي معلومات أكتر زي اسم المؤلف).
    if (score > entry.maxScore || (score === entry.maxScore && member.length > (entry.displays[0]?.length ?? 0))) {
      entry.displays.unshift(member);
      entry.maxScore = score;
    } else {
      entry.displays.push(member);
    }
  }

  console.log(`\n Aggregated ${all.length / 2} → ${merged.size} canonical keys (dropped ${dropped})`);
  console.log("\nTop 20 after migration:");
  const sorted = [...merged.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 20);
  for (const [key, { score, displays }] of sorted) {
    console.log(`  ${score.toString().padStart(4)}  ${displays[0]}  ${displays.length > 1 ? `[+${displays.length - 1} variants]` : ""}`);
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written. Re-run without --dry to apply.");
    await redis.quit();
    return;
  }

  // ── Apply changes atomically: write to temp key, then RENAME ──
  console.log(`\nWriting to ${TMP_KEY}...`);
  await redis.del(TMP_KEY).catch(() => {});

  // Pipeline for ZADD + HSET
  const pipe = redis.pipeline();
  let zaddCount = 0;
  let hsetCount = 0;
  for (const [key, { score, displays }] of merged.entries()) {
    pipe.zadd(TMP_KEY, score, key);
    pipe.hset(DISPLAY_KEY, key, displays[0]);
    zaddCount++;
    hsetCount++;
  }
  await pipe.exec();
  console.log(`  ZADD ${zaddCount} entries to ${TMP_KEY}`);
  console.log(`  HSET ${hsetCount} entries to ${DISPLAY_KEY}`);

  // Atomic swap
  await redis.rename(TMP_KEY, KEY);
  console.log(`  RENAME ${TMP_KEY} → ${KEY} (atomic swap)`);

  // ── Verify ──
  const finalCount = await redis.zcard(KEY);
  const displayCount = await redis.hlen(DISPLAY_KEY);
  console.log(`\nVerification:`);
  console.log(`  ${KEY}: ${finalCount} entries`);
  console.log(`  ${DISPLAY_KEY}: ${displayCount} entries`);

  console.log("\n✓ Migration complete.");
  await redis.quit();
}

main().catch((err) => {
  console.error("MIGRATION FAILED:", err);
  process.exit(1);
});
