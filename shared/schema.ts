import { sql } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  firstName: text("first_name"),
  username: text("username"),
  totalSearches: integer("total_searches").default(0),
  totalDownloads: integer("total_downloads").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const searchLogs = pgTable("search_logs", {
  id: serial("id").primaryKey(),
  telegramUserId: text("telegram_user_id").notNull(),
  userName: text("user_name"),
  query: text("query").notNull(),
  bookFound: boolean("book_found").default(false),
  pdfSent: boolean("pdf_sent").default(false),
  resultCount: integer("result_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  // index لـ getUserSearchHistory — WHERE telegram_user_id = ? AND pdf_sent = true ORDER BY created_at DESC
  userPdfIdx: index("search_logs_user_pdf_idx").on(table.telegramUserId, table.pdfSent),
  // index لـ getRecentSearches — ORDER BY created_at DESC LIMIT N
  createdAtIdx: index("search_logs_created_at_idx").on(table.createdAt),
}));

export const cachedBooks = pgTable("cached_books", {
  id: serial("id").primaryKey(),
  bookQuery: text("book_query").notNull(),
  bookQueryNormalized: text("book_query_normalized").notNull().unique(),
  telegramFileId: text("telegram_file_id").notNull(),
  fileName: text("file_name"),
  bookName: text("book_name").notNull(),
  sourceUrl: text("source_url"),
  timesServed: integer("times_served").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const dailyLimits = pgTable("daily_limits", {
  id: serial("id").primaryKey(),
  telegramUserId: text("telegram_user_id").notNull(),
  date: text("date").notNull(),
  downloadCount: integer("download_count").default(0),
}, (table) => ({
  // ✅ FIX: unique constraint لضمان atomic upsert في incrementDailyDownload
  userDateUnique: unique("daily_limits_user_date_unique").on(table.telegramUserId, table.date),
}));

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true });
export const insertSearchLogSchema = createInsertSchema(searchLogs).omit({ id: true, createdAt: true });
export const insertCachedBookSchema = createInsertSchema(cachedBooks).omit({ id: true, createdAt: true, timesServed: true });
export const insertDailyLimitSchema = createInsertSchema(dailyLimits).omit({ id: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertSearchLog = z.infer<typeof insertSearchLogSchema>;
export type SearchLog = typeof searchLogs.$inferSelect;
export type InsertCachedBook = z.infer<typeof insertCachedBookSchema>;
export type CachedBook = typeof cachedBooks.$inferSelect;
export type InsertDailyLimit = z.infer<typeof insertDailyLimitSchema>;
export type DailyLimit = typeof dailyLimits.$inferSelect;
