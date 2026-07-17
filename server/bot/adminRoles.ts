// ══════════════════════════════════════════════
// ADMIN ROLES — owner | operator | viewer
//
// Env (comma-separated telegram ids):
//   ADMIN_OWNER_IDS     — full power (default: all ADMIN_IDS)
//   ADMIN_OPERATOR_IDS  — ops + writes except destructive global
//   ADMIN_VIEWER_IDS    — read-only agent + dashboards
//
// If only ADMIN_IDS is set (legacy), everyone is operator (write OK).
// ══════════════════════════════════════════════

import { ADMIN_IDS } from "./config.js";

export type AdminRole = "owner" | "operator" | "viewer";

function parseIds(envVal: string | undefined): Set<string> {
  const s = new Set<string>();
  for (const part of (envVal || "").split(/[,\s]+/)) {
    const id = part.trim();
    if (/^\d{5,15}$/.test(id)) s.add(id);
  }
  return s;
}

let _owners: Set<string> | null = null;
let _operators: Set<string> | null = null;
let _viewers: Set<string> | null = null;

function load(): void {
  if (_owners) return;
  _owners = parseIds(process.env.ADMIN_OWNER_IDS);
  _operators = parseIds(process.env.ADMIN_OPERATOR_IDS);
  _viewers = parseIds(process.env.ADMIN_VIEWER_IDS);
  // Legacy: no role envs → all ADMIN_IDS are operators (full write as before)
  if (_owners.size === 0 && _operators.size === 0 && _viewers.size === 0) {
    _operators = new Set(ADMIN_IDS);
    _owners = new Set(ADMIN_IDS);
  }
  // Owners always include operators chain for permission
  for (const id of ADMIN_IDS) {
    if (!_owners!.has(id) && !_operators!.has(id) && !_viewers!.has(id)) {
      // unlisted admin id from ADMIN_IDS → operator
      _operators!.add(id);
    }
  }
}

export function getAdminRole(userId: string): AdminRole | null {
  load();
  if (!ADMIN_IDS.has(userId) && !_owners!.has(userId) && !_operators!.has(userId) && !_viewers!.has(userId)) {
    // Still allow classic ADMIN_IDS only
    if (!ADMIN_IDS.has(userId)) return null;
  }
  if (_owners!.has(userId)) return "owner";
  if (_operators!.has(userId)) return "operator";
  if (_viewers!.has(userId)) return "viewer";
  if (ADMIN_IDS.has(userId)) return "operator";
  return null;
}

export function isAdminAny(userId: string): boolean {
  return getAdminRole(userId) !== null || ADMIN_IDS.has(userId);
}

/** Can run write tools (ban, pause, broadcast, …). */
export function canWrite(userId: string): boolean {
  const r = getAdminRole(userId);
  return r === "owner" || r === "operator";
}

/** Destructive global ops: broadcast, wipe cache patterns, remove LLM providers. */
export function canDestructive(userId: string): boolean {
  return getAdminRole(userId) === "owner";
}

/** Tools blocked for viewers (by name). */
export const VIEWER_BLOCKED_WRITES = true;

export function assertCanRunTool(userId: string, toolName: string, isWrite: boolean): void {
  const role = getAdminRole(userId) || (ADMIN_IDS.has(userId) ? "operator" : null);
  if (!role) throw new Error("not an admin");
  if (!isWrite) return;
  if (role === "viewer") {
    throw new Error(`role=viewer cannot run write tool: ${toolName}`);
  }
  const destructive = new Set([
    "broadcast",
    "clear_cache",
    "remove_llm_provider",
    "run_backup",
    "toggle_maintenance",
  ]);
  if (destructive.has(toolName) && role !== "owner") {
    // operators may still toggle maintenance in practice — only block broadcast + remove provider for non-owners
    if (toolName === "broadcast" || toolName === "remove_llm_provider") {
      throw new Error(`role=${role} cannot run destructive tool: ${toolName} (owner only)`);
    }
  }
}
