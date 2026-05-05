// ══════════════════════════════════════════════════════════════
// LOG BUFFER — circular ring of recent log lines for the dashboard
// ══════════════════════════════════════════════════════════════
// نحفظ آخر N سطر في الذاكرة بدل ما نطلب من admin يفتح shell على
// الـ container كل مرة عاوز يشوف الـ logs. Lightweight: ~500 سطر
// × ~250 char = ~125KB max — مفيش ضغط على RAM.

const MAX_LINES = 500;

interface BufferedLine {
  ts:    number;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  ns:    string;
  msg:   string;
  meta?: Record<string, unknown>;
}

const ring: BufferedLine[] = [];

export function pushLog(
  level: BufferedLine["level"],
  ns:    string,
  msg:   string,
  meta?: Record<string, unknown>,
): void {
  ring.push({ ts: Date.now(), level, ns, msg, meta });
  if (ring.length > MAX_LINES) ring.splice(0, ring.length - MAX_LINES);
}

export function getRecentLogs(limit = 200, levelFilter?: string): BufferedLine[] {
  const slice = ring.slice(-Math.min(limit, MAX_LINES));
  if (!levelFilter) return slice;
  const lvl = levelFilter.toUpperCase();
  return slice.filter(l => l.level === lvl);
}

export function getLogBufferStats(): { size: number; max: number; oldestTs: number | null } {
  return {
    size:     ring.length,
    max:      MAX_LINES,
    oldestTs: ring[0]?.ts ?? null,
  };
}
