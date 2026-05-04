import { eq, desc, sql, sum, count, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  users, searchLogs, cachedBooks, dailyLimits,
  type User, type InsertUser, type SearchLog, type InsertSearchLog,
  type CachedBook, type InsertCachedBook, type DailyLimit, type InsertDailyLimit,
} from "@shared/schema";
import { canonicalizeForCache } from "./bot/text.js";

// ══════════════════════════════════════════════
// DB POOL — معدَّل وغير مُعرَّض للـ pool exhaustion
// ══════════════════════════════════════════════

// ── Graceful startup: لو DATABASE_URL مش موجود → البوت يشتغل بدون DB مع تحذير ──
if (!process.env.DATABASE_URL) {
  console.warn("[storage] ⚠️  DATABASE_URL not set — storage operations will fail gracefully");
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                   // أقصى عدد connections متزامنة
  idleTimeoutMillis: 30_000, // أغلق connections غير مستخدمة بعد 30 ثانية
  connectionTimeoutMillis: 5_000, // فشل سريع بدل انتظار طويل
  statement_timeout: 10_000, // لا استعلام يتجاوز 10 ثواني
});

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

export const db = drizzle(pool);

// FIX-WRONG-FILE (BUG-2/6/7/8): استخدم canonicalizeForCache الموحَّدة
// (تطبيع عربي + إزالة كلمات الحشو + تطبيع المسافات).
// السابقة كانت تطبيق سطحي: `toLowerCase().trim().replace(/\s+/g, " ")` فقط
// → "أرض زيكولا" و "ارض زيكولا" مفاتيح كاش منفصلة (تخزين مكرّر).
// → "تحميل كتاب أرض زيكولا pdf" و "أرض زيكولا" مفاتيح منفصلة (قراءة عمياء).
// canonicalizeForCache مُعرَّفة في bot/text.ts لتُستخدَم بنفس الشكل في
// كل المسارات (cache write + cache lookup + dashboard) بدون انحراف.
function normalizeQuery(q: string): string {
  return canonicalizeForCache(q);
}

// ══════════════════════════════════════════════
// INTERFACE
// ══════════════════════════════════════════════

export interface IStorage {
  getOrCreateUser(telegramId: string, firstName?: string, username?: string): Promise<User>;
  logSearch(log: InsertSearchLog): Promise<SearchLog>;
  incrementUserSearches(telegramId: string): Promise<void>;
  incrementUserDownloads(telegramId: string): Promise<void>;
  getRecentSearches(limit?: number): Promise<SearchLog[]>;
  getStats(): Promise<{ totalUsers: number; totalSearches: number; totalDownloads: number }>;
  getTopUsers(limit?: number): Promise<User[]>;
  getCachedBook(query: string): Promise<CachedBook | null>;
  cacheBook(data: InsertCachedBook): Promise<CachedBook>;
  incrementCacheServed(id: number): Promise<void>;
  getCacheStats(): Promise<{ totalCached: number; totalServed: number }>;
  deleteCachedBook(id: number): Promise<void>;
  purgeCachedBookByQuery(query: string): Promise<number>;
  getDailyDownloadCount(telegramUserId: string): Promise<number>;
  incrementDailyDownload(telegramUserId: string): Promise<void>;
  canDownload(telegramUserId: string, limit?: number): Promise<boolean>;
  getAllUserIds(): Promise<string[]>;
  getUserSearchHistory(telegramUserId: string, limit?: number): Promise<{ query: string; createdAt: Date | null }[]>;
  getAllUsersWithDetails(limit?: number, offset?: number): Promise<{ users: User[]; total: number }>;
}

// ══════════════════════════════════════════════
// IMPLEMENTATION
// ══════════════════════════════════════════════

export class DatabaseStorage implements IStorage {

  async getOrCreateUser(
    telegramId: string,
    firstName?: string,
    username?: string
  ): Promise<User> {
    const updateSet: Record<string, any> = {};
    if (firstName) updateSet.firstName = firstName;
    if (username)  updateSet.username  = username;

    // لو ما فيش حقول للتحديث (مثلاً نفس الـ id بدون firstName/username)
    // الكود القديم كان يضيف `telegramId = telegramId` كـ no-op لإرضاء Drizzle.
    // الأنظف: استخدم onConflictDoNothing ثم SELECT للحصول على الصف.
    if (Object.keys(updateSet).length === 0) {
      await db
        .insert(users)
        .values({ telegramId, firstName: null, username: null, totalSearches: 0, totalDownloads: 0 })
        .onConflictDoNothing({ target: users.telegramId });
      const rows = await db.select().from(users).where(eq(users.telegramId, telegramId)).limit(1);
      return rows[0];
    }

    const result = await db
      .insert(users)
      .values({ telegramId, firstName: firstName || null, username: username || null, totalSearches: 0, totalDownloads: 0 })
      .onConflictDoUpdate({ target: users.telegramId, set: updateSet })
      .returning();
    return result[0];
  }

  async logSearch(log: InsertSearchLog): Promise<SearchLog> {
    const inserted = await db.insert(searchLogs).values(log).returning();
    return inserted[0];
  }

  async incrementUserSearches(telegramId: string): Promise<void> {
    await db.update(users)
      .set({ totalSearches: sql`${users.totalSearches} + 1` })
      .where(eq(users.telegramId, telegramId));
  }

  async incrementUserDownloads(telegramId: string): Promise<void> {
    await db.update(users)
      .set({ totalDownloads: sql`${users.totalDownloads} + 1` })
      .where(eq(users.telegramId, telegramId));
  }

  async getRecentSearches(limit = 50): Promise<SearchLog[]> {
    return db.select().from(searchLogs).orderBy(desc(searchLogs.createdAt)).limit(limit);
  }

  /** ✅ FIX: query واحدة بدل اثنتين */
  async getStats(): Promise<{ totalUsers: number; totalSearches: number; totalDownloads: number }> {
    const result = await db
      .select({
        totalUsers:     count(),
        totalSearches:  sum(users.totalSearches),
        totalDownloads: sum(users.totalDownloads),
      })
      .from(users);

    return {
      totalUsers:     Number(result[0]?.totalUsers     || 0),
      totalSearches:  Number(result[0]?.totalSearches  || 0),
      totalDownloads: Number(result[0]?.totalDownloads || 0),
    };
  }

  async getTopUsers(limit = 10): Promise<User[]> {
    return db.select().from(users).orderBy(desc(users.totalSearches)).limit(limit);
  }

  async getCachedBook(query: string): Promise<CachedBook | null> {
    const normalized = normalizeQuery(query);
    const result = await db
      .select()
      .from(cachedBooks)
      .where(eq(cachedBooks.bookQueryNormalized, normalized))
      .limit(1);
    return result.length > 0 ? result[0] : null;
  }

  async cacheBook(data: InsertCachedBook): Promise<CachedBook> {
    const normalized = normalizeQuery(data.bookQuery);
    const inserted = await db
      .insert(cachedBooks)
      .values({ ...data, bookQueryNormalized: normalized })
      .onConflictDoUpdate({
        target: cachedBooks.bookQueryNormalized,
        set: {
          telegramFileId: data.telegramFileId,
          fileName:       data.fileName,
          sourceUrl:      data.sourceUrl,
        },
      })
      .returning();
    return inserted[0];
  }

  async incrementCacheServed(id: number): Promise<void> {
    await db.update(cachedBooks)
      .set({ timesServed: sql`${cachedBooks.timesServed} + 1` })
      .where(eq(cachedBooks.id, id));
  }

  async getCacheStats(): Promise<{ totalCached: number; totalServed: number }> {
    const result = await db
      .select({
        totalCached: count(),
        totalServed: sum(cachedBooks.timesServed),
      })
      .from(cachedBooks);
    return {
      totalCached: Number(result[0]?.totalCached || 0),
      totalServed: Number(result[0]?.totalServed || 0),
    };
  }

  async deleteCachedBook(id: number): Promise<void> {
    await db.delete(cachedBooks).where(eq(cachedBooks.id, id));
  }

  // FIX-WRONG-FILE (BUG-9): admin-triggered purge by query.
  // Used by /purge_cache <book> and the cleanup script for the
  // 34 pre-fix opaque-URL entries. Returns the number of rows deleted.
  async purgeCachedBookByQuery(query: string): Promise<number> {
    const normalized = canonicalizeForCache(query);
    const result = await db
      .delete(cachedBooks)
      .where(eq(cachedBooks.bookQueryNormalized, normalized))
      .returning({ id: cachedBooks.id });
    return result.length;
  }

  async getDailyDownloadCount(telegramUserId: string): Promise<number> {
    const today = new Date().toISOString().split("T")[0];
    const result = await db
      .select({ downloadCount: dailyLimits.downloadCount })
      .from(dailyLimits)
      .where(and(
        eq(dailyLimits.telegramUserId, telegramUserId),
        eq(dailyLimits.date, today)
      ))
      .limit(1);
    return result.length > 0 ? (result[0].downloadCount ?? 0) : 0;
  }

  /**
   * ✅ FIX: Race Condition (TOCTOU)
   * استخدام INSERT ... ON CONFLICT DO UPDATE بدل SELECT ثم INSERT/UPDATE
   * عملية ذرية واحدة لا يمكن تجزئتها
   */
  async incrementDailyDownload(telegramUserId: string): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    await db
      .insert(dailyLimits)
      .values({ telegramUserId, date: today, downloadCount: 1 })
      .onConflictDoUpdate({
        target: [dailyLimits.telegramUserId, dailyLimits.date],
        set: { downloadCount: sql`${dailyLimits.downloadCount} + 1` },
      });
  }

  async canDownload(telegramUserId: string, limit = 6): Promise<boolean> {
    const count = await this.getDailyDownloadCount(telegramUserId);
    return count < limit;
  }

  async getAllUserIds(): Promise<string[]> {
    const result = await db.select({ telegramId: users.telegramId }).from(users);
    return result.map((r) => r.telegramId);
  }

  /**
   * آخر N كتب حمّلها المستخدم — query مباشر أسرع من تحميل 500 سجل وتصفيتها
   */
  async getUserSearchHistory(telegramUserId: string, limit = 7): Promise<{ query: string; createdAt: Date | null }[]> {
    const result = await db
      .select({ query: searchLogs.query, createdAt: searchLogs.createdAt })
      .from(searchLogs)
      .where(and(
        eq(searchLogs.telegramUserId, telegramUserId),
        eq(searchLogs.pdfSent, true),
      ))
      .orderBy(desc(searchLogs.createdAt))
      .limit(limit);
    return result;
  }

  /**
   * جميع المستخدمين مع تفاصيلهم — مُرتَّبون بأكثر التحميلات
   * يدعم pagination عبر limit + offset
   */
  async getAllUsersWithDetails(limit = 50, offset = 0): Promise<{ users: User[]; total: number }> {
    const [rows, countResult] = await Promise.all([
      db.select().from(users)
        .orderBy(desc(users.totalDownloads))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(users),
    ]);
    return { users: rows, total: Number(countResult[0]?.total || 0) };
  }
}

export const storage = new DatabaseStorage();
