import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(write: (request: RunnerRequest) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "trustcommit-service-")); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ARK_API_KEY: "fixture-key", ARK_MODEL: "fixture-model", RUNTIME_PROVIDER: "container" });
  await writeCodexConfig(config);
  const requests: RunnerRequest[] = [];
  const runner: AgentRunner = { run: async (request) => { requests.push(request); await write(request); return { output: "done token=super-secret-value", threadId: "proposed-thread", usage: null }; }, cancel: async () => false, isAvailable: async () => true };
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner);
  await service.initialize(); const agent = await service.createAgent({ name: "Guarded" });
  return { service, agent, requests, config, store, runner };
}

async function waitFor(service: AgentService, runId: string, status: string) { await expect.poll(() => service.getRun(runId).status).toBe(status); }

describe("TrustCommit service integration", () => {
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

  it("deletion discards pending staging before archiving the live workspace", async () => {
    const { service, agent } = await setup(async (request) => writeFile(path.join(request.workspacePath, "pending.ts"), "pending\n"));
    const { run } = await service.sendMessage(agent.id, "pending"); await waitFor(service, run.id, "awaiting_review");
    const result = await service.deleteAgent(agent.id);
    expect(result.archivedWorkspace).toContain(".deleted");
    expect(service.listAgents()).toHaveLength(0);
  });
});
