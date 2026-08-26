import { randomUUID } from "node:crypto";
import type { AgentRun, AuditEvent, AuditEventType } from "./types.js";

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

export function redact(value: string, limit = 8_192): string {
  let safe = value.slice(0, limit);
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(pattern, "[REDACTED]");
  return safe;
}

export function auditEvent(run: Pick<AgentRun, "id" | "agentId">, type: AuditEventType, summary: string, ruleIds: string[] = []): AuditEvent {
  return { id: randomUUID(), runId: run.id, agentId: run.agentId, timestamp: new Date().toISOString(), type, summary: redact(summary, 1_000), ruleIds: [...new Set(ruleIds)].slice(0, 32) };
}
