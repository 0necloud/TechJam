import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import { ensureAgentCodexHome, isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  UpdateAgentInput,
  RunEvidence,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import { WorkspaceTransactionManager } from "./workspace-transaction.js";
import { createRunPolicy } from "./run-policy.js";
import { evaluateChanges } from "./change-policy.js";
import { adjudicatePrompt, ingressSummary, screenPrompt, screenWorkspace } from "./ingress-policy.js";
import { trifectaSummary } from "./trifecta-policy.js";
import { createIngressAdjudicator, type IngressAdjudicator } from "./ingress-adjudicator.js";
import { auditEvent, redact } from "./audit-recorder.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly decisionsInProgress = new Set<string>();
  private readonly transactions: WorkspaceTransactionManager;
  private readonly adjudicator: IngressAdjudicator;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
    adjudicator?: IngressAdjudicator,
  ) {
    this.transactions = new WorkspaceTransactionManager(config.workspaceRoot);
    this.adjudicator = adjudicator ?? createIngressAdjudicator(config);
  }

  /** Null when the model-backed half of the gate is switched off. */
  private get activeAdjudicator(): IngressAdjudicator | null {
    return this.adjudicator.name === "off" ? null : this.adjudicator;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.transactions.initialize();
    const snapshot = this.store.snapshot();
    for (const run of snapshot.runs) {
      if (run.transaction) await this.transactions.reconcile(run.transaction, run.status === "completed" && run.decision?.decision === "approve");
      if ((run.status === "queued" || run.status === "running") && run.transaction) await this.transactions.discard(run.transaction).catch(() => undefined);
      if (run.status === "awaiting_review" && run.transaction) {
        try { await access(run.transaction.stagingPath); } catch { await this.store.mutate((database) => {
          const stored = database.runs.find((item) => item.id === run.id);
          const agent = database.agents.find((item) => item.id === run.agentId);
          if (stored) { stored.status = "failed"; stored.error = "Pending review transaction was missing after restart"; stored.completedAt = now(); }
          if (agent) { agent.status = "error"; agent.lastError = stored?.error ?? null; }
        }); }
      }
    }
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
        if (agent.status === "review" && !database.runs.some((run) => run.agentId === agent.id && run.status === "awaiting_review")) agent.status = "ready";
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy" || current.status === "review") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy" || agent.status === "review") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    for (const run of this.getRuns(id)) if (run.transaction) await this.transactions.discard(run.transaction).catch(() => undefined);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const pending = this.getRuns(id).find((run) => run.status === "awaiting_review");
    if (pending) await this.cancelPendingReview(pending.id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRunEvidence(runId: string): Promise<RunEvidence> {
    const run = this.getRun(runId);
    const unchanged = run.transaction ? await this.transactions.liveDigest(run.transaction).then((value) => value === run.transaction!.initialDigest).catch(() => false) : true;
    const safeRun = { ...run, prompt: redact(run.prompt), output: run.output ? redact(run.output) : null, error: run.error ? redact(run.error) : null };
    const safeScreen = run.promptScreen ? { ...run.promptScreen, sanitizedPrompt: redact(run.promptScreen.sanitizedPrompt) } : null;
    return { run: safeRun, policy: run.policy, timeline: run.auditEvents, changes: run.changes, policyDecision: run.policyDecision, promptScreen: safeScreen, ingress: run.ingress, decision: run.decision, liveWorkspaceUnchanged: unchanged };
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    // Ingress point 1: judge the request before anything is staged. A pasted
    // credential is stripped (or refused) here so it never reaches the Runtime,
    // the transcript, or the audit record.
    const promptScreen = screenPrompt(prompt, this.config.ingress);
    if (promptScreen.outcome === "denied") {
      throw new HttpError(400, "Prompt rejected by the Airlock ingress gate: " + promptScreen.rules.map((rule) => rule.id + " " + rule.message).join(" "));
    }
    const screenedPrompt = promptScreen.sanitizedPrompt;
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt: screenedPrompt,
      output: null,
      error: null,
      usage: null,
      proposedThreadId: null,
      policy: null,
      transaction: null,
      changes: [],
      policyDecision: null,
      promptScreen,
      ingress: null,
      decision: null,
      auditEvents: [],
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: screenedPrompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy" || storedAgent.status === "review") {
        throw new HttpError(409, storedAgent.status === "review" ? "Review the pending Run before sending another message" : "This Agent is already running");
      }
      database.runs.push(run);
      run.auditEvents.push(auditEvent(run, "run.created", "Run queued for guarded execution"));
      run.auditEvents.push(auditEvent(run, "prompt.screened", promptScreen.outcome === "sanitized" ? "Prompt sanitized before staging" : promptScreen.requestsSensitiveAccess ? "Prompt requests sensitive material" : "Prompt screened with no findings", promptScreen.rules.map((rule) => rule.id)));
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      ingress: this.config.ingress,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    let transaction: AgentRun["transaction"] = null;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
        storedRun.policy = createRunPolicy(run.id, agentAtStart.id, this.config);
        storedRun.auditEvents.push(auditEvent(storedRun, "policy.created", "Staging-only container policy created"));
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      if (this.config.runtimeProvider !== "container") throw new Error("Airlock guarded Runs require RUNTIME_PROVIDER=container");
      transaction = await this.transactions.prepare(run.id, agentAtStart.workspacePath);
      const activeRun = this.getRun(run.id);
      // Ingress point 3: classify the staged copy, assess the lethal trifecta,
      // and pull anything above the resulting clearance back out. This is the
      // last moment a read can be stopped — after the mount exists, Codex reads
      // it with plain syscalls.
      const ingress = await screenWorkspace(transaction.stagingPath, this.transactions.withheldRoot(transaction), this.config.ingress, {
        adjudicator: this.activeAdjudicator,
        networkMode: activeRun.policy?.networkMode ?? "current-bridge",
        untrustedPrompt: activeRun.promptScreen?.untrustedReferences ?? [],
      });
      // The prompt judgement is advisory and must never fail the Run, so an
      // unreachable model is recorded rather than propagated.
      const promptJudgement = await adjudicatePrompt(run.prompt, this.config.ingress, this.activeAdjudicator).catch(() => {
        ingress.adjudicationErrors += 1;
        return null;
      });
      if (promptJudgement) {
        ingress.adjudications.unshift(promptJudgement);
        if (promptJudgement.raised) ingress.rules.push({ id: "IN041", message: "The ingress adjudicator judged this request to need material above the Run's clearance.", paths: [promptJudgement.rationale || "prompt"] });
      }
      if (ingress.outcome === "denied") {
        throw new Error("Airlock ingress gate denied this Run: " + ingress.rules.map((rule) => rule.id + " " + rule.message).join(" "));
      }
      const codexHomePath = await ensureAgentCodexHome(this.config, agentAtStart.id);
      await this.store.mutate((database) => {
        const stored = database.runs.find((item) => item.id === run.id);
        if (!stored) return;
        stored.transaction = transaction;
        stored.ingress = ingress;
        stored.auditEvents.push(auditEvent(stored, "workspace.staged", "Live workspace copied into an isolated transaction"), auditEvent(stored, "ingress.scanned", ingressSummary(ingress), ingress.rules.map((rule) => rule.id)));
        if (ingress.trifecta) stored.auditEvents.push(auditEvent(stored, "ingress.trifecta", trifectaSummary(ingress.trifecta), ingress.trifecta.rules.map((rule) => rule.id)));
        if (ingress.adjudications.length) stored.auditEvents.push(auditEvent(stored, "ingress.adjudicated", ingress.adjudications.length + " adjudication(s), " + ingress.adjudications.filter((record) => record.raised).length + " raised above the deterministic verdict", ingress.adjudications.filter((record) => record.raised).map((record) => (record.kind === "prompt" ? "IN041" : "IN040"))));
        if (ingress.withheld.length) stored.auditEvents.push(auditEvent(stored, "ingress.withheld", ingress.withheld.length + " file(s) withheld from the Runtime: " + ingress.withheld.map((file) => file.path).join(", "), ingress.withheld.flatMap((file) => file.ruleIds)));
        stored.auditEvents.push(auditEvent(stored, "runtime.started", "Container Runtime started with staging and private session mounts"));
      });
      const result = await this.runner.run({
        runId: run.id,
        agentId: agentAtStart.id,
        workspacePath: transaction.stagingPath,
        codexHomePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        policy: activeRun.policy!,
      });
      const changes = await this.transactions.inspect(transaction, ingress.withheld);
      const decision = changes.length ? evaluateChanges(changes) : null;
      const inspectedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.auditEvents.push(auditEvent(storedRun, "runtime.completed", "Container Runtime completed"), auditEvent(storedRun, "workspace.inspected", `${changes.length} proposed file change(s) inspected`));
        storedRun.output = redact(result.output, 50_000);
        storedRun.usage = result.usage;
        storedRun.proposedThreadId = result.threadId;
        storedRun.changes = changes.map((change) => ({ ...change, ...(change.patch ? { patch: redact(change.patch) } : {}) }));
        storedRun.policyDecision = decision;
        if (decision?.outcome === "denied") {
          storedRun.status = "rejected"; storedRun.completedAt = inspectedAt;
          storedRun.auditEvents.push(auditEvent(storedRun, "policy.denied", "Change policy denied promotion", decision.rules.map((rule) => rule.id)));
          agent.status = "ready"; agent.codexThreadId = null;
        } else if (changes.length) {
          storedRun.status = "awaiting_review"; storedRun.auditEvents.push(auditEvent(storedRun, "policy.review_required", "Changes require human approval", decision?.rules.map((rule) => rule.id)));
          agent.status = "review";
        } else {
          storedRun.status = "completed"; storedRun.completedAt = inspectedAt;
          storedRun.auditEvents.push(auditEvent(storedRun, "run.completed", "Run completed without workspace changes"));
          database.messages.push({ id: randomUUID(), agentId: agent.id, runId: run.id, role: "assistant", content: storedRun.output ?? "", createdAt: inspectedAt });
          agent.status = "ready"; agent.codexThreadId = result.threadId;
        }
        agent.lastError = null;
        agent.updatedAt = inspectedAt;
      });
      if (decision?.outcome === "denied") {
        await this.transactions.discard(transaction);
        await this.store.mutate((database) => { const stored = database.runs.find((item) => item.id === run.id); if (stored) stored.auditEvents.push(auditEvent(stored, "workspace.discarded", "Denied staging transaction discarded")); });
      } else if (!changes.length) await this.transactions.discard(transaction);
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          storedRun.auditEvents.push(auditEvent(storedRun, "run.failed", cancelled ? "Run cancelled and staging discarded" : message));
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
      if (transaction) await this.transactions.discard(transaction).catch(() => undefined);
    }
  }

  async approveRun(runId: string, reason?: string): Promise<AgentRun> { return this.decideRun(runId, "approve", reason); }
  async rejectRun(runId: string, reason?: string): Promise<AgentRun> { return this.decideRun(runId, "reject", reason); }

  private async decideRun(runId: string, decision: "approve" | "reject", reason?: string): Promise<AgentRun> {
    if (this.decisionsInProgress.has(runId)) throw new HttpError(409, "A decision is already being applied");
    const run = this.getRun(runId);
    if (run.status !== "awaiting_review" || !run.transaction) throw new HttpError(409, "Only Runs awaiting review may receive a decision");
    this.decisionsInProgress.add(runId);
    try {
      // Withheld originals are restored into staging first, so promoting an
      // approved Run can never replace a live sensitive file with its tombstone.
      if (decision === "approve") await this.transactions.promote(run.transaction, run.ingress?.withheld ?? []); else await this.transactions.discard(run.transaction);
      const timestamp = now();
      const decided = await this.store.mutate((database) => {
        const stored = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === run.agentId);
        if (!stored || !agent || stored.status !== "awaiting_review") throw new HttpError(409, "Run decision state changed");
        stored.decision = { decision, reason: reason?.trim() || null, decidedAt: timestamp };
        stored.completedAt = timestamp;
        stored.status = decision === "approve" ? "completed" : "rejected";
        stored.auditEvents.push(auditEvent(stored, decision === "approve" ? "human.approved" : "human.rejected", decision === "approve" ? "Human approved proposed changes" : "Human rejected proposed changes"), auditEvent(stored, decision === "approve" ? "workspace.promoted" : "workspace.discarded", decision === "approve" ? "Staging workspace promoted" : "Staging workspace discarded"), auditEvent(stored, "run.completed", decision === "approve" ? "Run completed after approval" : "Run closed after rejection"));
        if (decision === "approve") {
          agent.codexThreadId = stored.proposedThreadId;
          database.messages.push({ id: randomUUID(), agentId: agent.id, runId, role: "assistant", content: stored.output ?? "", createdAt: timestamp });
        } else agent.codexThreadId = null;
        agent.status = "ready"; agent.lastError = null; agent.updatedAt = timestamp;
        return structuredClone(stored);
      });
      if (decision === "approve") await this.transactions.finalizePromotion(run.transaction).catch(() => undefined);
      return decided;
    } finally { this.decisionsInProgress.delete(runId); }
  }

  private async cancelPendingReview(runId: string): Promise<void> {
    const run = this.getRun(runId);
    if (run.transaction) await this.transactions.discard(run.transaction);
    await this.store.mutate((database) => { const stored = database.runs.find((item) => item.id === runId); if (stored && stored.status === "awaiting_review") { stored.status = "cancelled"; stored.error = "Run cancelled while awaiting review"; stored.completedAt = now(); stored.auditEvents.push(auditEvent(stored, "workspace.discarded", "Pending staging transaction discarded"), auditEvent(stored, "run.failed", "Run cancelled while awaiting review")); } });
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && (agent.status === "busy" || agent.status === "review")) {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.store.mutate((database) => {
        const active = database.runs.find((run) => run.agentId === agentId && (run.status === "queued" || run.status === "running"));
        if (active?.policy && !active.policy.revokedAt) active.policy.revokedAt = now();
      });
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
