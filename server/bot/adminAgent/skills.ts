// ══════════════════════════════════════════════════════════
// Admin Agent — Skill router (v4)
// ══════════════════════════════════════════════════════════
// Reduces tool-noise: the model only sees tools relevant to the
// inferred skill for this turn (plus always-on core tools).
// Hermes/OpenClaw-style: narrower action space → better plans.

export type AgentSkill =
  | "general"
  | "diagnostic"
  | "analytics"
  | "ops"
  | "control"
  | "users"
  | "llm"
  | "files"
  | "research"
  | "memory";

/** Always available regardless of skill. */
export const CORE_TOOLS = new Set([
  "think",
  "reflect",
  "create_plan",
  "update_plan",
  "get_plan",
  "save_knowledge",
  "recall_knowledge",
  "delete_knowledge",
  "save_incident",
  "list_incidents",
  "quick_overview",
  "get_dashboard_snapshot",
  "run_playbook",
  "compare_periods",
  "skill_status",
  "run_subagents",
]);

const SKILL_TOOLS: Record<AgentSkill, string[]> = {
  general: [
    "get_system_health",
    "get_today_stats",
    "get_queue_status",
    "get_delivery_metrics",
    "get_user_count",
    "get_feature_flags",
    "get_retention_metrics",
  ],
  diagnostic: [
    "diagnose",
    "get_system_health",
    "get_source_health",
    "get_recent_traces",
    "get_recent_logs",
    "get_queue_status",
    "get_dlq_jobs",
    "get_delivery_metrics",
    "get_pdf_validation_stats",
    "get_tel_counters_summary",
    "get_counters",
    "get_proactive_log",
    "trigger_health_check",
    "exec_command",
    "fetch_url",
    "read_file",
    "list_dir",
  ],
  analytics: [
    "get_today_stats",
    "get_weekly_stats",
    "get_total_stats",
    "get_user_count",
    "get_funnel_stats",
    "get_top_books",
    "get_delivery_metrics",
    "get_retention_metrics",
    "get_image_stats",
    "get_library_taste_stats",
    "generate_report",
    "compare_periods",
    "get_tel_counters_summary",
  ],
  ops: [
    "get_queue_status",
    "get_dlq_jobs",
    "clear_dlq",
    "cancel_user_jobs",
    "clear_cache",
    "pause_source",
    "unpause_source",
    "get_source_health",
    "toggle_maintenance",
    "get_maintenance_status",
    "broadcast",
    "set_announce",
    "run_backup",
    "list_backups",
    "exec_command",
    "list_schedules",
    "add_schedule",
    "remove_schedule",
    "toggle_schedule",
  ],
  control: [
    "get_feature_flags",
    "set_feature_flag",
    "get_limits",
    "set_limit",
    "get_admin_audit",
    "get_notification_prefs",
    "set_notification_prefs",
    "list_ab_tests",
    "create_ab_test",
    "score_ab_variant",
    "delete_ab_test",
  ],
  users: [
    "get_user",
    "get_user_ops",
    "get_user_count",
    "get_premium_info",
    "set_premium",
    "grant_premium_30d",
    "revoke_premium",
    "set_premium_days",
    "ban_user",
    "unban_user",
    "list_bans",
    "set_user_daily_limit",
    "set_user_note",
    "search_users",
    "get_known_groups",
  ],
  llm: [
    "list_llm_providers",
    "add_llm_provider",
    "update_llm_provider",
    "remove_llm_provider",
    "set_llm_priority",
    "llm_provider_stats",
    "llm_test_provider",
    "reset_llm_provider_stats",
  ],
  files: [
    "read_file",
    "write_file",
    "list_dir",
    "exec_command",
  ],
  research: [
    "web_search",
    "fetch_url",
  ],
  memory: [
    "save_knowledge",
    "recall_knowledge",
    "delete_knowledge",
    "save_incident",
    "list_incidents",
    "create_plan",
    "update_plan",
    "get_plan",
  ],
};

/**
 * Infer skill from admin free-text (Arabic + English keywords).
 * Defaults to general (small safe set + core).
 */
export function inferSkill(text: string): AgentSkill {
  const t = text.toLowerCase();

  if (/llm|provider|cerebras|groq|openrouter|مفتاح|api.?key|نموذج|model/.test(t))
    return "llm";
  if (/ban|حظر|premium|بريم|مستخدم|user.?id|ملاحظة|حد.?يومي|unban|منح|إلغاء.?premium/.test(t))
    return "users";
  if (/feature|flag|ميزة|حد.?عام|limit|إعلان|announce|a\/?b|اختبار/.test(t) &&
      !/بطيء|فشل|خطأ|debug|تشخيص/.test(t))
    return "control";
  if (/docker|ملف|config|compose|log|exec|shell|df |free |قرص|ذاكرة.?node|read_file|write_file/.test(t))
    return "files";
  if (/ابحث.?في|web.?search|fetch.?url|توثيق|documentation|google|موقع/.test(t))
    return "research";
  if (/ذاكرة|احفظ|incident|حادث|خطة|plan|knowledge|تذكّر|تذكر/.test(t))
    return "memory";
  if (/تقرير|ترند|إحصا|stats|funnel|أسبوعي|أسبوعي|كم|نسبة|تحليل|analytics|report|compare|قارن|صور|retention|retention|مكتبة|ذوق/.test(t) &&
      !/صلح|أصلح|fix|pause|أوقف/.test(t))
    return "analytics";
  if (/صلح|أصلح|fix|pause|unpause|dlq|cache|صيانة|maintenance|broadcast|بث|backup|نسخ|طابور|queue|شغّل|أوقف.?مصدر/.test(t))
    return "ops";
  if (/ليه|لماذا|مشكل|بطيء|فشل|خطأ|timeout|تشخيص|diagnose|health|صحة|traces|logs|debug|واقع|منهار/.test(t))
    return "diagnostic";

  return "general";
}

/** Tool names allowed for this skill (core ∪ skill set). */
export function toolsForSkill(skill: AgentSkill): Set<string> {
  const set = new Set<string>(CORE_TOOLS);
  for (const n of SKILL_TOOLS[skill] || []) set.add(n);
  // general also gets a bit of diagnostic basics
  if (skill === "general") {
    for (const n of SKILL_TOOLS.diagnostic.slice(0, 8)) set.add(n);
  }
  return set;
}

export function skillLabelAr(skill: AgentSkill): string {
  const m: Record<AgentSkill, string> = {
    general: "عام",
    diagnostic: "تشخيص",
    analytics: "تحليل",
    ops: "عمليات",
    control: "تحكم",
    users: "مستخدمون",
    llm: "نماذج LLM",
    files: "ملفات/نظام",
    research: "بحث خارجي",
    memory: "ذاكرة",
  };
  return m[skill] || skill;
}
