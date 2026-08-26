import type { FileChange, PolicyDecision, PolicyRule } from "./types.js";

export interface ChangePolicyOptions { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number }
const messages: Record<string, string> = {
  TC001: "The path is absolute or escapes the workspace.",
  TC002: "Environment files may contain secrets and cannot be promoted.",
  TC003: "Platform-managed Git, Codex, or Agent configuration cannot be changed.",
  TC004: "Symbolic links are blocked because they can escape the workspace.",
  TC005: "Credential-like content cannot be promoted.",
  TC006: "The change set exceeds configured size limits.",
  TC100: "Workspace changes require human review before promotion.",
};
const credential = /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-\/.+=]{8,}/i;

export function evaluateChanges(changes: FileChange[], options: ChangePolicyOptions = {}): PolicyDecision {
  const maxFiles = options.maxFiles ?? 100;
  const maxTotalBytes = options.maxTotalBytes ?? 5_000_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const violations = new Map<string, Set<string>>();
  const add = (id: string, file: string) => { const paths = violations.get(id) ?? new Set<string>(); paths.add(file); violations.set(id, paths); };
  let total = 0;
  for (const change of changes) {
    const normalized = change.path.replace(/\\/g, "/");
    total += change.size;
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) add("TC001", change.path);
    if (/^\.env(?:\..+)?$/i.test(normalized)) add("TC002", change.path);
    if (normalized === "AGENTS.md" || /^(?:\.git|\.codex)(?:\/|$)/.test(normalized)) add("TC003", change.path);
    if (change.symbolicLink) add("TC004", change.path);
    if (change.patch && credential.test(change.patch)) add("TC005", change.path);
    if (change.size > maxFileBytes) add("TC006", change.path);
  }
  if (changes.length > maxFiles || total > maxTotalBytes) add("TC006", "(change set)");
  const rules: PolicyRule[] = [...violations].map(([id, paths]) => ({ id, message: messages[id]!, paths: [...paths] }));
  if (rules.length) return { outcome: "denied", risk: "high", rules };
  return { outcome: "review_required", risk: changes.some((change) => change.kind === "deleted" || /^(?:package(?:-lock)?\.json|\.github\/|deploy\/)/.test(change.path)) ? "medium" : "low", rules: [{ id: "TC100", message: messages.TC100!, paths: changes.map((change) => change.path) }] };
}
