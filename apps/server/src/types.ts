export type AgentStatus = "ready" | "busy" | "review" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";
export type MessageRole = "user" | "assistant";

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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  proposedThreadId: string | null;
  policy: RunPolicy | null;
  transaction: WorkspaceTransaction | null;
  changes: FileChange[];
  policyDecision: PolicyDecision | null;
  decision: HumanDecision | null;
  auditEvents: AuditEvent[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  runId: string;
  agentId: string;
  workspacePath: string;
  codexHomePath: string;
  prompt: string;
  threadId: string | null;
  policy: RunPolicy;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export interface RunPolicy {
  id: string;
  runId: string;
  agentId: string;
  runtime: "container";
  workspaceAccess: "staging-only";
  sessionAccess: "agent-only";
  networkMode: "current-bridge" | "ark-gateway" | "none";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  maxDurationMs: number;
}

export interface WorkspaceTransaction {
  runId: string;
  livePath: string;
  transactionPath: string;
  stagingPath: string;
  rollbackPath: string;
  initialDigest: string;
}

export interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  size: number;
  patch?: string;
  symbolicLink?: boolean;
}

export interface PolicyRule {
  id: string;
  message: string;
  paths: string[];
}

export interface PolicyDecision {
  outcome: "review_required" | "denied";
  risk: "low" | "medium" | "high";
  rules: PolicyRule[];
}

export interface HumanDecision {
  decision: "approve" | "reject";
  reason: string | null;
  decidedAt: string;
}

export type AuditEventType =
  | "run.created" | "policy.created" | "workspace.staged"
  | "runtime.started" | "runtime.completed" | "workspace.inspected"
  | "policy.review_required" | "policy.denied" | "human.approved"
  | "human.rejected" | "workspace.promoted" | "workspace.discarded"
  | "run.completed" | "run.failed";

export interface AuditEvent {
  id: string;
  runId: string;
  agentId: string;
  timestamp: string;
  type: AuditEventType;
  summary: string;
  ruleIds: string[];
}

export interface RunEvidence {
  run: AgentRun;
  policy: RunPolicy | null;
  timeline: AuditEvent[];
  changes: FileChange[];
  policyDecision: PolicyDecision | null;
  decision: HumanDecision | null;
  liveWorkspaceUnchanged: boolean;
}
