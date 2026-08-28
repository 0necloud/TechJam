import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { RunPolicy, RunnerRequest } from "./types.js";

export function createRunPolicy(runId: string, agentId: string, config: AppConfig): RunPolicy {
  const created = Date.now();
  return {
    id: randomUUID(), runId, agentId, runtime: "container",
    workspaceAccess: "staging-only", sessionAccess: "agent-only",
    networkMode: "current-bridge", createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + config.codexTimeoutMs).toISOString(),
    revokedAt: null, maxDurationMs: config.codexTimeoutMs,
  };
}

function isChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}

export function validateRunPolicy(request: RunnerRequest, config: AppConfig): void {
  const policy = request.policy;
  if (config.runtimeProvider !== "container") throw new Error("Airlock guarded Runs require the container Runtime");
  if (policy.runId !== request.runId || policy.agentId !== request.agentId) throw new Error("Run policy identity mismatch");
  if (policy.runtime !== "container" || policy.workspaceAccess !== "staging-only" || policy.sessionAccess !== "agent-only") throw new Error("Unsupported Run policy capability");
  if (policy.revokedAt) throw new Error("Run policy has been revoked");
  if (Date.parse(policy.expiresAt) <= Date.now()) throw new Error("Run policy has expired");
  const expectedTransactionRoot = path.join(config.workspaceRoot, ".transactions", request.runId);
  if (!isChild(expectedTransactionRoot, request.workspacePath)) throw new Error("Runtime workspace is not this Run's staging workspace");
  const expectedHome = path.join(config.codexHome, request.agentId);
  if (path.resolve(request.codexHomePath) !== path.resolve(expectedHome)) throw new Error("Runtime Codex home does not belong to this Agent");
}
