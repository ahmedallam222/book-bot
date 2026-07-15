// ══════════════════════════════════════════════
// TYPES — خلاصة الكتب
// ══════════════════════════════════════════════

export interface SourceConfig {
  domain:    string;
  name:      string;
  emoji:     string;
  priority:  number;
  searchUrl: (query: string) => string;
  isArabic:  boolean;
}

export interface BookResult {
  id:            string;
  title:         string;
  url:           string;
  directPdfUrl:  string | null;
  source:        SourceConfig;
  access:        "direct_pdf" | "download_page" | "catalog_page" | "protected_page";
  accessReason?: string;
  _score?:       number;
  /** Bytes when known (e.g. Telegram search); used for size-aware ranking. */
  fileSize?:     number;
}

export interface DownloadResult {
  ok:               boolean;
  fileId?:          string;
  sizeMB?:          string;
  sendMode?:        "direct" | "local";
  permanent?:       boolean;
  rejectedContent?: boolean;
  // True when validatePdfContent's NO verdict came from Mistral (paid call).
  // Used by bookRequest.ts to count consecutive Mistral rejections per query
  // and short-circuit further Mistral calls once the streak crosses a
  // threshold — see MISTRAL_NO_STREAK_LIMIT in config.ts.
  mistralRejected?: boolean;
  // True when the file exceeds Telegram bot upload limit (~50MB).
  // bookRequest treats this as permanent and may surface a size-specific message.
  tooLarge?: boolean;
}

export interface QueueJob {
  id:         string;
  userId:     string;
  chatId:     number;
  bookName:   string;
  token:      string;
  userName?:  string | null;
  priority:   "high" | "normal";
  retries:    number;
  createdAt:  number;
  startedAt?: number;
  /** message_id لرسالة المستخدم — يُستخدم لإضافة reactions (✅/😢) عند الانتهاء */
  userMessageId?: number;
  /**
   * PR G — auto-summary trigger. لو المستخدم كتب "لخصلي" أو "ملخص"
   * في رسالة الطلب الأصلية، نُفعّل توليد الملخص تلقائيًا بعد إرسال
   * الكتاب بنجاح. تُحدَّد القيمة في commands.ts قبل enqueue من خلال
   * detectSummaryIntent() على اسم الكتاب الخام.
   */
  wantsSummary?: boolean;
}

export interface EnqueueResult {
  ok:        boolean;
  reason?:   "user_limit" | "queue_full";
  position?: number;
}
