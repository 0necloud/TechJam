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
export type SensitivityLevel = "public" | "internal" | "confidential" | "restricted";
export interface PromptScreen { outcome: "allowed" | "sanitized" | "denied"; sanitizedPrompt: string; requestsSensitiveAccess: boolean; rules: PolicyRule[] }
export type IngressSource = "rules" | "agent";
export type StopReason = "complete" | "signal" | "budget" | "name-only" | "metadata-only";
export interface WithheldFile { path: string; level: SensitivityLevel; ruleIds: string[]; reason: string; bytesInspected: number; size: number; source: IngressSource }
export interface ObservedFile { path: string; level: SensitivityLevel; ruleIds: string[]; stopReason: StopReason; bytesInspected: number; size: number; source: IngressSource }
export interface AdjudicationRecord { kind: "prompt" | "file"; target: string; deterministicLevel: SensitivityLevel; level: SensitivityLevel; confidence: "low" | "medium" | "high"; rationale: string; raised: boolean }
export type Capability = "private-data" | "untrusted-content" | "external-comms";
export interface CapabilityFinding { capability: Capability; present: boolean; reason: string; evidence: string[] }
export interface TrifectaDecision { findings: CapabilityFinding[]; present: Capability[]; outcome: "safe" | "mitigated" | "unmitigated"; requestedClearance: SensitivityLevel; effectiveClearance: SensitivityLevel; mitigation: string | null; rules: PolicyRule[] }
export interface IngressDecision { outcome: "allowed" | "restricted" | "denied"; clearance: SensitivityLevel; effectiveClearance: SensitivityLevel; enforcement: "off" | "audit" | "enforce"; scannedFiles: number; bytesInspected: number; bytesSkipped: number; earlyStops: number; withheld: WithheldFile[]; observed: ObservedFile[]; rules: PolicyRule[]; adjudicator: string; adjudications: AdjudicationRecord[]; adjudicationErrors: number; trifecta: TrifectaDecision | null }
export interface RunEvidence { run: AgentRun; policy: RunPolicy | null; timeline: AuditEvent[]; changes: FileChange[]; policyDecision: PolicyDecision | null; promptScreen: PromptScreen | null; ingress: IngressDecision | null; decision: { decision: "approve" | "reject"; reason: string | null; decidedAt: string } | null; liveWorkspaceUnchanged: boolean }

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
