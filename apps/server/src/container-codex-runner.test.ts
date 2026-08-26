import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  const policy = (runId: string, agentId: string) => ({ id: "policy", runId, agentId, runtime: "container" as const, workspaceAccess: "staging-only" as const, sessionAccess: "agent-only" as const, networkMode: "current-bridge" as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null, maxDurationMs: 60_000 });
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        runId: "run",
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        codexHomePath: "/tmp/codex-home/agent-unsafe",
        prompt: "write a small program",
        threadId: null,
        policy: policy("run", "agent/unsafe"),
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home/agent-unsafe,dst=/codex-home");
    expect(args).toContain("--read-only");
    expect(args).toContain("/tmp:rw,nosuid,nodev,noexec,size=64m");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        runId: "run",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        codexHomePath: "/tmp/codex-home/agent",
        prompt: "continue",
        threadId: "thread-123",
        policy: policy("run", "agent"),
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
