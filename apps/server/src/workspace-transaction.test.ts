import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateChanges } from "./change-policy.js";
import { WorkspaceTransactionManager } from "./workspace-transaction.js";

const roots: string[] = [];
afterEach(async () => { const { rm } = await import("node:fs/promises"); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "trustcommit-tx-")); roots.push(root);
  const live = path.join(root, "agent"); await mkdir(live); await writeFile(path.join(live, "main.ts"), "export const value = 1;\n");
  const manager = new WorkspaceTransactionManager(root); await manager.initialize();
  const transaction = await manager.prepare("00000000-0000-4000-8000-000000000001", live);
  return { root, live, manager, transaction };
}

describe("WorkspaceTransactionManager", () => {
  it("keeps changes quarantined and promotes the exact staging tree", async () => {
    const { live, manager, transaction } = await fixture();
    await writeFile(path.join(transaction.stagingPath, "main.ts"), "export const value = 2;\n");
    await writeFile(path.join(transaction.stagingPath, "main.test.ts"), "test('value', () => {});\n");
    const changes = await manager.inspect(transaction);
    expect(changes.map((change) => [change.path, change.kind])).toEqual([["main.test.ts", "added"], ["main.ts", "modified"]]);
    expect(await readFile(path.join(live, "main.ts"), "utf8")).toContain("1");
    await manager.promote(transaction);
    expect(await readFile(path.join(live, "main.ts"), "utf8")).toContain("2");
  });

  it("refuses promotion after a concurrent live change", async () => {
    const { live, manager, transaction } = await fixture();
    await writeFile(path.join(transaction.stagingPath, "main.ts"), "staged\n");
    await writeFile(path.join(live, "main.ts"), "human edit\n");
    await expect(manager.promote(transaction)).rejects.toThrow("changed");
    expect(await readFile(path.join(live, "main.ts"), "utf8")).toBe("human edit\n");
  });

  it("restores an interrupted promotion to reviewable state", async () => {
    const { live, manager, transaction } = await fixture();
    await writeFile(path.join(transaction.stagingPath, "main.ts"), "promoted but not committed\n");
    await manager.promote(transaction);
    await manager.reconcile(transaction, false);
    expect(await readFile(path.join(live, "main.ts"), "utf8")).toContain("value = 1");
    expect((await manager.inspect(transaction))[0]).toMatchObject({ path: "main.ts", kind: "modified" });
  });

  it("reports symlinks for deterministic denial", async () => {
    const { manager, transaction } = await fixture();
    await symlink("/etc/passwd", path.join(transaction.stagingPath, "escape"));
    const changes = await manager.inspect(transaction);
    expect(evaluateChanges(changes)).toMatchObject({ outcome: "denied", rules: [{ id: "TC004" }] });
  });

  it("fails closed when the live workspace already contains a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trustcommit-tx-")); roots.push(root);
    const live = path.join(root, "agent"); await mkdir(live); await symlink("/etc/passwd", path.join(live, "escape"));
    const manager = new WorkspaceTransactionManager(root); await manager.initialize();
    await expect(manager.prepare("00000000-0000-4000-8000-000000000002", live)).rejects.toThrow("symbolic link");
  });

  it("does not hide newly-created protected metadata", async () => {
    const { manager, transaction } = await fixture();
    await mkdir(path.join(transaction.stagingPath, ".git"));
    await writeFile(path.join(transaction.stagingPath, ".git", "config"), "malicious\n");
    const changes = await manager.inspect(transaction);
    expect(evaluateChanges(changes).rules.map((rule) => rule.id)).toContain("TC003");
  });

  it("does not hide protected metadata created below the workspace root", async () => {
    const { manager, transaction } = await fixture();
    await mkdir(path.join(transaction.stagingPath, "vendor", ".git", "hooks"), { recursive: true });
    await writeFile(path.join(transaction.stagingPath, "vendor", ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    const changes = await manager.inspect(transaction);
    expect(changes.map((change) => change.path)).toContain("vendor/.git/hooks/pre-commit");
    expect(evaluateChanges(changes).rules.map((rule) => rule.id)).toContain("TC003");
  });

  it("denies a nested environment file whose content evades the credential scanner", async () => {
    const { live, manager, transaction } = await fixture();
    await mkdir(path.join(transaction.stagingPath, "config"), { recursive: true });
    await writeFile(path.join(transaction.stagingPath, "config", ".env"), "DEBUG=true\nDATABASE_URL=postgres://user@host/db\n");
    const changes = await manager.inspect(transaction);
    expect(changes.map((change) => change.path)).toContain("config/.env");
    const decision = evaluateChanges(changes);
    expect(decision.outcome).toBe("denied");
    expect(decision.rules.map((rule) => rule.id)).toEqual(["TC002"]);
    expect(await readFile(path.join(live, "main.ts"), "utf8")).toContain("value = 1");
  });
});

describe("change policy", () => {
  it("denies protected, traversal, credential, and oversized changes", () => {
    const decision = evaluateChanges([
      { path: ".env", kind: "added", beforeHash: null, afterHash: "a", size: 20, patch: "+API_KEY=abcdefghijk" },
      { path: "../escape", kind: "added", beforeHash: null, afterHash: "b", size: 1 },
      { path: "huge.bin", kind: "added", beforeHash: null, afterHash: "c", size: 2_000_000 },
    ]);
    expect(decision.outcome).toBe("denied");
    expect(decision.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["TC001", "TC002", "TC005", "TC006"]));
  });

  it("denies protected files at every path depth", () => {
    const added = (file: string) => ({ path: file, kind: "added" as const, beforeHash: null, afterHash: "a", size: 24 });
    const decision = evaluateChanges([added("config/.env"), added("apps/web/.env.production"), added("vendor/.git/hooks/pre-commit"), added("tools/.codex/config.toml"), added("docs/AGENTS.md")]);
    expect(decision.outcome).toBe("denied");
    expect(decision.rules.find((rule) => rule.id === "TC002")?.paths).toEqual(["config/.env", "apps/web/.env.production"]);
    expect(decision.rules.find((rule) => rule.id === "TC003")?.paths).toEqual(["vendor/.git/hooks/pre-commit", "tools/.codex/config.toml", "docs/AGENTS.md"]);
  });

  it("denies protected names regardless of filesystem case folding", () => {
    const decision = evaluateChanges([{ path: "sub/.GIT/config", kind: "added", beforeHash: null, afterHash: "a", size: 8 }]);
    expect(decision.rules.map((rule) => rule.id)).toEqual(["TC003"]);
  });

  it("allows paths that only resemble a protected name", () => {
    const decision = evaluateChanges([
      { path: ".github/workflows/ci.yml", kind: "modified", beforeHash: "a", afterHash: "b", size: 40 },
      { path: "src/environment.ts", kind: "added", beforeHash: null, afterHash: "c", size: 40 },
      { path: "vendor/mygit/config", kind: "added", beforeHash: null, afterHash: "d", size: 40 },
      { path: "docs/agents-guide.md", kind: "added", beforeHash: null, afterHash: "e", size: 40 },
    ]);
    expect(decision.outcome).toBe("review_required");
    expect(decision.rules.map((rule) => rule.id)).toEqual(["TC100"]);
  });

  it("raises review risk for a dependency manifest inside a workspace package", () => {
    const decision = evaluateChanges([{ path: "apps/server/package.json", kind: "modified", beforeHash: "a", afterHash: "b", size: 40 }]);
    expect(decision).toMatchObject({ outcome: "review_required", risk: "medium" });
  });
});
