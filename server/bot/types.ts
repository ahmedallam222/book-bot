// ══════════════════════════════════════════════
// TYPES — كل الـ interfaces في مكان واحد
// ══════════════════════════════════════════════

export interface SourceConfig {
  domain: string;
  name: string;
  emoji: string;
  searchUrl: (q: string) => string;
  priority: number;
  /** true = موقع عربي → يستخدم lang:ar في Firecrawl + query مع "pdf" */
  isArabic?: boolean;
  enabled?: boolean;
}

export interface BookResult {
  id: string;
  title: string;
  url: string;
  directPdfUrl: string | null;
  source: SourceConfig;
  author?: string;
  access: "direct_pdf" | "download_page" | "catalog_page" | "protected_page";
  accessReason?: string;
  // _allPdfs حُذفت — لم تكن تُعبَأ من makeResult() أبداً
  _score?: number;
}

export interface SessionEntry {
  type: "feedback" | "retry";
  url?: string;
  bookName: string;
  ts: number;
}

export interface DownloadResult {
  ok: boolean;
  fileId?: string;
  sizeMB?: string;
  permanent?: boolean;
  /** الطريقة المستخدمة: Telegram direct أم local download */
  sendMode?: "direct" | "local";
  /** true إذا رُفض الملف بسبب عدم تطابق المحتوى مع الكتاب المطلوب */
  rejectedContent?: boolean;
}

export type Intent = "greeting" | "help" | "thanks" | "last" | "book" | "unknown";

export interface DetectedIntent {
  type: Intent;
  bookName?: string;
}

// ══════════════════════════════════════════════
// QUEUE JOB — وحدة العمل في الـ queue
// ══════════════════════════════════════════════

export type QueueJobStatus = "pending" | "processing" | "done" | "failed" | "cancelled";

export interface QueueJob {
  id: string;            // UUID
  userId: string;
  chatId: number;
  bookName: string;
  token: string;
  userName?: string | null;
  priority: "high" | "normal";
  status: QueueJobStatus;
  retries: number;
  createdAt: number;     // Date.now()
  startedAt?: number;
  progressMsgId?: number; // message_id لرسالة التقدم
  failReason?: string;
}

// ══════════════════════════════════════════════
// USER SETTINGS — إعدادات لكل مستخدم (Redis)
// ══════════════════════════════════════════════

export interface UserSettings {
  isPremium: boolean;
  dailyLimitOverride?: number;   // لو الأدمن ضبط حد مخصص
  notes?: string;                // ملاحظة من الأدمن
}
