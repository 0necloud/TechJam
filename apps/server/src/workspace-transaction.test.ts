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
});
