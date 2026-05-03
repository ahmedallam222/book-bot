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
}

export interface EnqueueResult {
  ok:        boolean;
  reason?:   "user_limit" | "queue_full";
  position?: number;
}
