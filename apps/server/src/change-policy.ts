import type { FileChange, PolicyDecision, PolicyRule } from "./types.js";

export interface ChangePolicyOptions { maxFiles?: number; maxTotalBytes?: number; maxFileBytes?: number }
const messages: Record<string, string> = {
  TC001: "The path is absolute or escapes the workspace.",
  TC002: "Environment files may contain secrets and cannot be promoted.",
  TC003: "Platform-managed Git, Codex, or Agent configuration cannot be changed.",
  TC004: "Symbolic links are blocked because they can escape the workspace.",
  TC005: "Credential-like content cannot be promoted.",
  TC006: "The change set exceeds configured size limits.",
  TC007: "A file withheld by the ingress gate was modified inside the Runtime.",
  TC100: "Workspace changes require human review before promotion.",
};
const credential = /(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-\/.+=]{8,}/i;
// Protected names are matched on every path segment, not only at the workspace
// root: a nested `config/.env` or `vendor/.git/hooks/pre-commit` is as dangerous
// as one at the root, and Codex reads `AGENTS.md` from every directory it walks.
// Matching is case-insensitive so denial does not depend on host filesystem
// case-folding rules.
const environmentFile = /^\.env(?:\..+)?$/i;
const platformMetadata = /^\.(?:git|codex)$/i;
const agentInstructions = /^AGENTS\.md$/i;
const dependencyManifest = /^package(?:-lock)?\.json$/i;
const rootReviewDirectory = /^(?:\.github|deploy)\//;

const normalize = (value: string): string => value.replace(/\\/g, "/");
const hasSegment = (normalized: string, pattern: RegExp): boolean => normalized.split("/").some((segment) => pattern.test(segment));
const needsElevatedReview = (value: string): boolean => {
  const normalized = normalize(value);
  return rootReviewDirectory.test(normalized) || hasSegment(normalized, dependencyManifest);
};

export function evaluateChanges(changes: FileChange[], options: ChangePolicyOptions = {}): PolicyDecision {
  const maxFiles = options.maxFiles ?? 100;
  const maxTotalBytes = options.maxTotalBytes ?? 5_000_000;
  const maxFileBytes = options.maxFileBytes ?? 1_000_000;
  const violations = new Map<string, Set<string>>();
  const add = (id: string, file: string) => { const paths = violations.get(id) ?? new Set<string>(); paths.add(file); violations.set(id, paths); };
  let total = 0;
  for (const change of changes) {
    const normalized = normalize(change.path);
    total += change.size;
    if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) add("TC001", change.path);
    if (hasSegment(normalized, environmentFile)) add("TC002", change.path);
    if (hasSegment(normalized, platformMetadata) || hasSegment(normalized, agentInstructions)) add("TC003", change.path);
    if (change.symbolicLink) add("TC004", change.path);
    if (change.patch && credential.test(change.patch)) add("TC005", change.path);
    if (change.size > maxFileBytes) add("TC006", change.path);
    if (change.withheldTamper) add("TC007", change.path);
  }
  if (changes.length > maxFiles || total > maxTotalBytes) add("TC006", "(change set)");
  const rules: PolicyRule[] = [...violations].map(([id, paths]) => ({ id, message: messages[id]!, paths: [...paths] }));
  if (rules.length) return { outcome: "denied", risk: "high", rules };
  return { outcome: "review_required", risk: changes.some((change) => change.kind === "deleted" || needsElevatedReview(change.path)) ? "medium" : "low", rules: [{ id: "TC100", message: messages.TC100!, paths: changes.map((change) => change.path) }] };
}
