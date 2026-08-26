import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { validateRunPolicy } from "./run-policy.js";
import type { RunPolicy, RunnerRequest } from "./types.js";

const config = loadConfig({ NODE_ENV: "test", AGENT_WORKSPACE_ROOT: "/tmp/tc-workspaces", CODEX_HOME: "/tmp/tc-codex", RUNTIME_PROVIDER: "container" });
function request(overrides: Partial<RunPolicy> = {}, requestOverrides: Partial<RunnerRequest> = {}): RunnerRequest {
  const policy: RunPolicy = { id: "p", runId: "run-1", agentId: "agent-a", runtime: "container", workspaceAccess: "staging-only", sessionAccess: "agent-only", networkMode: "current-bridge", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null, maxDurationMs: 60_000, ...overrides };
  return { runId: "run-1", agentId: "agent-a", workspacePath: "/tmp/tc-workspaces/.transactions/run-1/workspace", codexHomePath: "/tmp/tc-codex/agent-a", prompt: "task", threadId: null, policy, ...requestOverrides };
}

describe("Run policy validation", () => {
  it("accepts only the matching staging workspace and Agent home", () => {
    expect(() => validateRunPolicy(request(), config)).not.toThrow();
    expect(() => validateRunPolicy(request({}, { workspacePath: "/tmp/tc-workspaces/agent-a" }), config)).toThrow("staging");
    expect(() => validateRunPolicy(request({}, { codexHomePath: "/tmp/tc-codex/agent-b" }), config)).toThrow("does not belong");
  });
  it("rejects expired and revoked capabilities", () => {
    expect(() => validateRunPolicy(request({ expiresAt: new Date(0).toISOString() }), config)).toThrow("expired");
    expect(() => validateRunPolicy(request({ revokedAt: new Date().toISOString() }), config)).toThrow("revoked");
  });
});
