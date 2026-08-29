import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { IngressAdjudicator } from "./ingress-adjudicator.js";
import type { AgentRunner, RunnerRequest } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(write: (request: RunnerRequest) => Promise<void>, adjudicator?: IngressAdjudicator) {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-service-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "fixture-key", ARK_MODEL: "fixture-model", RUNTIME_PROVIDER: "container", ...(adjudicator ? { INGRESS_ADJUDICATOR: "ark" } : {}) });
  await writeCodexConfig(config);
  const requests: RunnerRequest[] = [];
  const runner: AgentRunner = { run: async (request) => { requests.push(request); await write(request); return { output: "done token=super-secret-value", threadId: "proposed-thread", usage: null }; }, cancel: async () => false, isAvailable: async () => true };
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner, adjudicator);
  await service.initialize(); const agent = await service.createAgent({ name: "Guarded" });
  return { service, agent, requests, config, store, runner };
}

async function waitFor(service: AgentService, runId: string, status: string) { await expect.poll(() => service.getRun(runId).status).toBe(status); }

describe("Airlock service integration", () => {
  it("stages safe changes, preserves live files, and promotes only on approval", async () => {
    const { service, agent, requests } = await setup(async (request) => writeFile(path.join(request.workspacePath, "safe.ts"), "export {};\n"));
    const { run } = await service.sendMessage(agent.id, "make a safe file"); await waitFor(service, run.id, "awaiting_review");
    expect(requests[0]?.workspacePath).toContain(path.join(".transactions", run.id, "workspace"));
    expect(requests[0]?.workspacePath).not.toBe(agent.workspacePath);
    expect(requests[0]?.codexHomePath).toBe(path.join(path.dirname(path.dirname(requests[0]!.codexHomePath)), "codex", agent.id));
    await expect(readFile(path.join(agent.workspacePath, "safe.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await service.approveRun(run.id, "reviewed");
    expect(await readFile(path.join(agent.workspacePath, "safe.ts"), "utf8")).toContain("export");
    expect(service.getAgent(agent.id).codexThreadId).toBe("proposed-thread");
  });

  it("rejects safe changes without contaminating workspace or session", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "discard.ts"), "discard\n"));
    const { run } = await service.sendMessage(agent.id, "make then reject"); await waitFor(service, run.id, "awaiting_review");
    await service.rejectRun(run.id, "not wanted");
    await expect(readFile(path.join(agent.workspacePath, "discard.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(service.getAgent(agent.id).codexThreadId).toBeNull();
  });

  it("automatically denies protected changes and redacts evidence", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, ".env"), "API_KEY=super-secret-value\n"));
    const { run } = await service.sendMessage(agent.id, "write .env password=super-secret-value"); await waitFor(service, run.id, "rejected");
    await expect(readFile(path.join(agent.workspacePath, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.policyDecision?.rules.map((rule) => rule.id)).toContain("TC002");
    expect(JSON.stringify(evidence)).not.toContain("super-secret-value");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("denies a protected file hidden below the workspace root", async () => {
    const { service, agent } = await setup(async (request) => {
      await mkdir(path.join(request.workspacePath, "config"), { recursive: true });
      await writeFile(path.join(request.workspacePath, "config", ".env"), "DEBUG=true\nDATABASE_URL=postgres://user@host/db\n");
    });
    const { run } = await service.sendMessage(agent.id, "add a nested config file"); await waitFor(service, run.id, "rejected");
    await expect(readFile(path.join(agent.workspacePath, "config", ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.policyDecision?.rules.map((rule) => rule.id)).toContain("TC002");
    expect(evidence.policyDecision?.rules.find((rule) => rule.id === "TC002")?.paths).toEqual(["config/.env"]);
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("blocks approval when the live workspace changes concurrently", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "safe.ts"), "safe\n"));
    const { run } = await service.sendMessage(agent.id, "change"); await waitFor(service, run.id, "awaiting_review");
    await writeFile(path.join(agent.workspacePath, "README.md"), "human change\n");
    await expect(service.approveRun(run.id)).rejects.toThrow("changed");
    expect(service.getRun(run.id).status).toBe("awaiting_review");
  });

  it("stop cleans a pending transaction and returns a restartable Agent", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "pending.ts"), "pending\n"));
    const { run } = await service.sendMessage(agent.id, "pending"); await waitFor(service, run.id, "awaiting_review");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect(service.getRun(run.id).status).toBe("cancelled");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await expect(readFile(path.join(agent.workspacePath, "pending.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an intact pending review across restart", async () => {
    const { service, agent, config, store, runner } = await setup(async (request) => writeFile(path.join(request.workspacePath, "pending.ts"), "pending\n"));
    const { run } = await service.sendMessage(agent.id, "pending"); await waitFor(service, run.id, "awaiting_review");
    const restarted = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner);
    await restarted.initialize();
    expect(restarted.getRun(run.id).status).toBe("awaiting_review");
    expect(restarted.getAgent(agent.id).status).toBe("review");
    await restarted.rejectRun(run.id);
  });

  it("withholds a classified document from the Runtime and restores it on approval", async () => {
    let mounted = "";
    const { service, agent } = await setup(async (request) => {
      mounted = await readFile(path.join(request.workspacePath, "docs", "handbook.md"), "utf8");
      await writeFile(path.join(request.workspacePath, "summary.md"), "summary\n");
    });
    await mkdir(path.join(agent.workspacePath, "docs"), { recursive: true });
    await writeFile(path.join(agent.workspacePath, "docs", "handbook.md"), "COMPANY CONFIDENTIAL\n\nUnreleased pricing model.\n");

    const { run } = await service.sendMessage(agent.id, "write a summary of the docs folder");
    await waitFor(service, run.id, "awaiting_review");

    // The Runtime saw a tombstone, never the marked document.
    expect(mounted).toContain("[AIRLOCK WITHHELD]");
    expect(mounted).not.toContain("Unreleased pricing model");

    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.ingress?.withheld.map((file) => file.path)).toEqual(["docs/handbook.md"]);
    expect(evidence.ingress?.rules.map((rule) => rule.id)).toContain("IN021");
    expect(evidence.timeline.map((event) => event.type)).toEqual(expect.arrayContaining(["prompt.screened", "ingress.scanned", "ingress.withheld"]));
    // The tombstone is the gate's own substitution, so it is not an Agent change.
    expect(evidence.changes.map((change) => change.path)).toEqual(["summary.md"]);

    await service.approveRun(run.id, "reviewed");
    expect(await readFile(path.join(agent.workspacePath, "docs", "handbook.md"), "utf8")).toContain("Unreleased pricing model");
    expect(await readFile(path.join(agent.workspacePath, "summary.md"), "utf8")).toContain("summary");
  });

  it("denies the change set when the Runtime edits a withheld file", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "notes.md"), "CONFIDENTIAL\n\noverwritten by the Runtime\n"));
    await writeFile(path.join(agent.workspacePath, "notes.md"), "STRICTLY CONFIDENTIAL\n\noriginal briefing\n");

    const { run } = await service.sendMessage(agent.id, "rewrite the notes");
    await waitFor(service, run.id, "rejected");

    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.policyDecision?.rules.map((rule) => rule.id)).toContain("TC007");
    expect(await readFile(path.join(agent.workspacePath, "notes.md"), "utf8")).toContain("original briefing");
  });

  it("withholds an unmarked document once the adjudicator judges it sensitive", async () => {
    let mounted = "";
    const adjudicator: IngressAdjudicator = {
      name: "fake",
      judge: async (request) => (request.path === "docs/board-notes.md" ? { level: "confidential", confidence: "high", rationale: "Unannounced acquisition terms." } : null),
    };
    const { service, agent } = await setup(async (request) => {
      mounted = await readFile(path.join(request.workspacePath, "docs", "board-notes.md"), "utf8");
      await writeFile(path.join(request.workspacePath, "summary.md"), "summary\n");
    }, adjudicator);
    await mkdir(path.join(agent.workspacePath, "docs"), { recursive: true });
    // No banner, no credential, no telling file name: deterministic rules pass it.
    await writeFile(path.join(agent.workspacePath, "docs", "board-notes.md"), "Notes from the meeting.\n\nWe close the Helios acquisition in Q3 for 40 million.\n");

    const { run } = await service.sendMessage(agent.id, "summarise the docs folder");
    await waitFor(service, run.id, "awaiting_review");

    expect(mounted).toContain("[AIRLOCK WITHHELD]");
    expect(mounted).not.toContain("Helios acquisition");
    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.ingress?.withheld).toMatchObject([{ path: "docs/board-notes.md", source: "agent" }]);
    expect(evidence.ingress?.adjudications.some((record) => record.raised)).toBe(true);
    expect(evidence.timeline.map((event) => event.type)).toContain("ingress.adjudicated");

    await service.approveRun(run.id, "reviewed");
    expect(await readFile(path.join(agent.workspacePath, "docs", "board-notes.md"), "utf8")).toContain("Helios acquisition");
  });

  it("sanitizes a pasted credential before the prompt reaches the Runtime", async () => {
    const { service, agent, requests } = await setup(async (request) => writeFile(path.join(request.workspacePath, "safe.ts"), "export {};\n"));
    const { run, message } = await service.sendMessage(agent.id, "call the API with api_key=sk-live-9f2b7c1d4e6a8b0c2d4e");
    await waitFor(service, run.id, "awaiting_review");

    expect(requests[0]?.prompt).not.toContain("sk-live-9f2b7c1d4e6a8b0c2d4e");
    expect(message.content).not.toContain("sk-live-9f2b7c1d4e6a8b0c2d4e");
    const evidence = await service.getRunEvidence(run.id);
    expect(evidence.promptScreen?.outcome).toBe("sanitized");
    expect(JSON.stringify(evidence)).not.toContain("sk-live-9f2b7c1d4e6a8b0c2d4e");
  });

  it("deletion discards pending staging before archiving the live workspace", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "pending.ts"), "pending\n"));
    const { run } = await service.sendMessage(agent.id, "pending"); await waitFor(service, run.id, "awaiting_review");
    const result = await service.deleteAgent(agent.id);
    expect(result.archivedWorkspace).toContain(".deleted");
    expect(service.listAgents()).toHaveLength(0);
  });
});

describe("operator settings", () => {
  it("layers an override over the environment default and applies it to the next Run", async () => {
    const { service, agent } = await setup(async () => undefined);
    await writeFile(path.join(agent.workspacePath, ".env"), "ARK_API_KEY=demo\n");

    expect(service.getIngressSettings().effective.clearance).toBe("internal");
    const first = await service.sendMessage(agent.id, "look around");
    await waitFor(service, first.run.id, "completed");
    expect((await service.getRunEvidence(first.run.id)).ingress?.withheld.map((f) => f.path)).toEqual([".env"]);

    await service.updateIngressSettings({ clearance: "restricted" });
    expect(service.getIngressSettings().effective.clearance).toBe("restricted");

    const second = await service.sendMessage(agent.id, "look again");
    await waitFor(service, second.run.id, "completed");
    const evidence = await service.getRunEvidence(second.run.id);
    expect(evidence.ingress?.withheld).toEqual([]);
    expect(evidence.ingress?.clearance).toBe("restricted");
  });

  it("records every change and flags the ones that reduce protection", async () => {
    const { service } = await setup(async () => undefined);
    await service.updateIngressSettings({ clearance: "restricted", enforcement: "audit" });
    await service.updateIngressSettings({ clearance: "public" });

    const log = service.getIngressSettings().log;
    expect(log.map((entry) => entry.field + " " + entry.from + "->" + entry.to)).toEqual([
      "clearance restricted->public",
      "enforcement enforce->audit",
      "clearance internal->restricted",
    ]);
    // Raising clearance lets the Run read more, so it weakens the control.
    expect(log.find((entry) => entry.to === "restricted")?.weakens).toBe(true);
    expect(log.find((entry) => entry.to === "audit")?.weakens).toBe(true);
    // Dropping back to public tightens it again, so this one does not weaken.
    expect(log.find((entry) => entry.to === "public")?.weakens).toBe(false);
  });

  it("ignores a change that does not move the setting", async () => {
    const { service } = await setup(async () => undefined);
    await service.updateIngressSettings({ clearance: "internal" });
    expect(service.getIngressSettings().log).toEqual([]);
    expect(service.getIngressSettings().overrides).toEqual({});
  });
});
