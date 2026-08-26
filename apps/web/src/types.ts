export type AgentStatus = "ready" | "busy" | "review" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "awaiting_review" | "completed" | "rejected" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  completedAt: string | null;
}

export interface RunPolicy { id: string; runtime: "container"; workspaceAccess: "staging-only"; sessionAccess: "agent-only"; networkMode: "current-bridge" | "none" | "ark-gateway"; expiresAt: string }
export interface FileChange { path: string; kind: "added" | "modified" | "deleted"; beforeHash: string | null; afterHash: string | null; size: number; patch?: string }
export interface PolicyRule { id: string; message: string; paths: string[] }
export interface PolicyDecision { outcome: "review_required" | "denied"; risk: "low" | "medium" | "high"; rules: PolicyRule[] }
export interface AuditEvent { id: string; timestamp: string; type: string; summary: string; ruleIds: string[] }
export interface RunEvidence { run: AgentRun; policy: RunPolicy | null; timeline: AuditEvent[]; changes: FileChange[]; policyDecision: PolicyDecision | null; decision: { decision: "approve" | "reject"; reason: string | null; decidedAt: string } | null; liveWorkspaceUnchanged: boolean }

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
