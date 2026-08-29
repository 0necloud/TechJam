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
  promptScreen: PromptScreen | null;
  ingress: IngressDecision | null;
  decision: HumanDecision | null;
  auditEvents: AuditEvent[];
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Database {
  version: 3;
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
  /** Set when the Runtime edited a file the ingress gate had withheld. */
  withheldTamper?: boolean;
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
  | "run.completed" | "run.failed"
  | "prompt.screened" | "ingress.scanned" | "ingress.withheld" | "ingress.denied"
  | "ingress.restored" | "ingress.adjudicated" | "ingress.trifecta";

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
  promptScreen: PromptScreen | null;
  ingress: IngressDecision | null;
  decision: HumanDecision | null;
  liveWorkspaceUnchanged: boolean;
}

export type SensitivityLevel = "public" | "internal" | "confidential" | "restricted";
export type IngressEnforcement = "off" | "audit" | "enforce";

export interface IngressOptions {
  clearance: SensitivityLevel;
  enforcement: IngressEnforcement;
  maxBytesPerFile: number;
  promptSecrets: "redact" | "deny";
  adjudicator: "off" | "ark";
  /** Ceiling on model calls per Run, so screening cost stays bounded. */
  adjudicatorMaxFiles: number;
  adjudicatorExcerptBytes: number;
  adjudicatorTimeoutMs: number;
}

export interface PromptScreen {
  outcome: "allowed" | "sanitized" | "denied";
  sanitizedPrompt: string;
  requestsSensitiveAccess: boolean;
  /** URLs the prompt points the Agent at: untrusted content arriving by instruction. */
  untrustedReferences: string[];
  rules: PolicyRule[];
}

/** Which half of the gate reached the verdict for one file. */
export type IngressSource = "rules" | "agent";

export interface WithheldFile {
  path: string;
  level: SensitivityLevel;
  ruleIds: string[];
  reason: string;
  bytesInspected: number;
  size: number;
  tombstoneHash: string;
  source: IngressSource;
}

export interface ObservedFile {
  path: string;
  level: SensitivityLevel;
  ruleIds: string[];
  stopReason: "complete" | "signal" | "budget" | "name-only" | "metadata-only";
  bytesInspected: number;
  size: number;
  source: IngressSource;
}

export interface IngressDecision {
  outcome: "allowed" | "restricted" | "denied";
  clearance: SensitivityLevel;
  enforcement: IngressEnforcement;
  scannedFiles: number;
  bytesInspected: number;
  bytesSkipped: number;
  earlyStops: number;
  withheld: WithheldFile[];
  observed: ObservedFile[];
  rules: PolicyRule[];
  adjudicator: string;
  adjudications: AdjudicationRecord[];
  /** Judgements that could not be obtained; recorded rather than hidden. */
  adjudicationErrors: number;
  /** Lethal-trifecta assessment, and the clearance the gate actually enforced. */
  trifecta: TrifectaDecision | null;
  effectiveClearance: SensitivityLevel;
}

/** One model judgement about a prompt or a staged file. */
export interface Adjudication {
  level: SensitivityLevel;
  confidence: "low" | "medium" | "high";
  rationale: string;
}

export interface AdjudicationRequest {
  kind: "prompt" | "file";
  path?: string | undefined;
  excerpt: string;
  deterministicLevel: SensitivityLevel;
  clearance: SensitivityLevel;
}

/** What the adjudicator was asked and what it changed, kept for the audit trail. */
export interface AdjudicationRecord {
  kind: "prompt" | "file";
  target: string;
  deterministicLevel: SensitivityLevel;
  level: SensitivityLevel;
  confidence: "low" | "medium" | "high";
  rationale: string;
  /** True when the judgement raised the level above the deterministic verdict. */
  raised: boolean;
}

/** The three capabilities that are only dangerous when held together. */
export type Capability = "private-data" | "untrusted-content" | "external-comms";

export interface CapabilityFinding {
  capability: Capability;
  present: boolean;
  reason: string;
  evidence: string[];
}

export interface TrifectaDecision {
  findings: CapabilityFinding[];
  present: Capability[];
  outcome: "safe" | "mitigated" | "unmitigated";
  requestedClearance: SensitivityLevel;
  /** What the ingress gate actually enforced after any mitigation. */
  effectiveClearance: SensitivityLevel;
  mitigation: string | null;
  rules: PolicyRule[];
}
