import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FileChange, WorkspaceTransaction } from "./types.js";

const EXCLUDED = new Set([".git", ".codex", "node_modules", "dist", ".transactions", ".rollback", ".deleted"]);
const PATCH_LIMIT = 16_384;

interface Entry { hash: string | null; size: number; content?: string; symbolicLink: boolean }

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function assertChild(parent: string, candidate: string, allowEqual = false): void {
  const root = path.resolve(parent);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  if ((!allowEqual && relative === "") || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Managed path escapes its TrustCommit root");
  }
}

async function scan(root: string, includeProtected = false): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  async function visit(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (EXCLUDED.has(item.name) && !(includeProtected && (item.name === ".git" || item.name === ".codex"))) continue;
      const absolute = path.join(directory, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      assertChild(root, absolute);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        entries.set(relative, { hash: null, size: info.size, symbolicLink: true });
      } else if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const data = info.size <= PATCH_LIMIT ? await readFile(absolute) : null;
        const text = data && !data.includes(0) ? data.toString("utf8") : undefined;
        entries.set(relative, { hash: await hashFile(absolute), size: info.size, ...(text !== undefined ? { content: text } : {}), symbolicLink: false });
      }
    }
  }
  await visit(root);
  return entries;
}

async function digest(root: string): Promise<string> {
  const entries = await scan(root);
  const hash = createHash("sha256");
  for (const [name, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update("\0").update(entry.symbolicLink ? "symlink" : entry.hash ?? "").update("\0");
  }
  return hash.digest("hex");
}

function patchFor(name: string, before?: Entry, after?: Entry): string | undefined {
  if (before?.content === undefined && after?.content === undefined) return undefined;
  const oldText = before?.content ?? "";
  const newText = after?.content ?? "";
  const result = ["--- a/" + name, "+++ b/" + name, "@@", ...oldText.split("\n").slice(0, 80).map((line) => "-" + line), ...newText.split("\n").slice(0, 80).map((line) => "+" + line)].join("\n");
  return result.slice(0, PATCH_LIMIT);
}

export class WorkspaceTransactionManager {
  private readonly transactionsRoot: string;
  private readonly rollbackRoot: string;

  constructor(private readonly workspaceRoot: string) {
    this.transactionsRoot = path.join(workspaceRoot, ".transactions");
    this.rollbackRoot = path.join(workspaceRoot, ".rollback");
  }

  async initialize(): Promise<void> {
    await mkdir(this.transactionsRoot, { recursive: true });
    await mkdir(this.rollbackRoot, { recursive: true });
  }

  async prepare(runId: string, livePath: string): Promise<WorkspaceTransaction> {
    assertChild(this.workspaceRoot, livePath);
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Invalid transaction Run ID");
    const transactionPath = path.join(this.transactionsRoot, runId);
    const stagingPath = path.join(transactionPath, "workspace");
    const rollbackPath = path.join(this.rollbackRoot, runId);
    assertChild(this.transactionsRoot, transactionPath);
    await rm(transactionPath, { recursive: true, force: true });
    await mkdir(transactionPath, { recursive: true });
    const liveEntries = await scan(livePath);
    if ([...liveEntries.values()].some((entry) => entry.symbolicLink)) throw new Error("Live workspace contains a symbolic link and cannot be staged");
    const initialDigest = await digest(livePath);
    await cp(livePath, stagingPath, {
      recursive: true,
      dereference: false,
      filter: (source) => {
        const relative = path.relative(livePath, source);
        if (!relative) return true;
        return !relative.split(path.sep).some((part) => EXCLUDED.has(part));
      },
    });
    return { runId, livePath: path.resolve(livePath), transactionPath, stagingPath, rollbackPath, initialDigest };
  }

  async inspect(transaction: WorkspaceTransaction): Promise<FileChange[]> {
    this.validate(transaction);
    const [before, after] = await Promise.all([scan(transaction.livePath), scan(transaction.stagingPath, true)]);
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    const changes: FileChange[] = [];
    for (const name of names) {
      const oldEntry = before.get(name);
      const newEntry = after.get(name);
      if (oldEntry?.hash === newEntry?.hash && oldEntry?.symbolicLink === newEntry?.symbolicLink) continue;
      const patch = patchFor(name, oldEntry, newEntry);
      changes.push({ path: name, kind: !oldEntry ? "added" : !newEntry ? "deleted" : "modified", beforeHash: oldEntry?.hash ?? null, afterHash: newEntry?.hash ?? null, size: newEntry?.size ?? oldEntry?.size ?? 0, ...(patch !== undefined ? { patch } : {}), ...(newEntry?.symbolicLink ? { symbolicLink: true } : {}) });
    }
    return changes;
  }

  async liveDigest(transaction: WorkspaceTransaction): Promise<string> {
    this.validate(transaction);
    return digest(transaction.livePath);
  }

  async promote(transaction: WorkspaceTransaction): Promise<void> {
    this.validate(transaction);
    if (await digest(transaction.livePath) !== transaction.initialDigest) throw new Error("Live workspace changed while the Run awaited review");
    await rm(transaction.rollbackPath, { recursive: true, force: true });
    await mkdir(path.dirname(transaction.rollbackPath), { recursive: true });
    await rename(transaction.livePath, transaction.rollbackPath);
    try {
      await rename(transaction.stagingPath, transaction.livePath);
    } catch (error) {
      try {
        await stat(transaction.livePath);
      } catch {
        await rename(transaction.rollbackPath, transaction.livePath);
      }
      throw error;
    }
  }

  async discard(transaction: WorkspaceTransaction): Promise<void> {
    this.validate(transaction);
    await rm(transaction.transactionPath, { recursive: true, force: true });
  }

  async finalizePromotion(transaction: WorkspaceTransaction): Promise<void> {
    this.validate(transaction);
    await rm(transaction.rollbackPath, { recursive: true, force: true });
    await rm(transaction.transactionPath, { recursive: true, force: true });
  }

  async reconcile(transaction: WorkspaceTransaction, promoted = false): Promise<void> {
    this.validate(transaction);
    const exists = async (target: string) => stat(target).then(() => true).catch(() => false);
    const [liveExists, rollbackExists, stagingExists] = await Promise.all([exists(transaction.livePath), exists(transaction.rollbackPath), exists(transaction.stagingPath)]);
    if (!liveExists && rollbackExists) await rename(transaction.rollbackPath, transaction.livePath);
    else if (liveExists && rollbackExists && promoted) await this.finalizePromotion(transaction);
    else if (liveExists && rollbackExists && !stagingExists) {
      await mkdir(transaction.transactionPath, { recursive: true });
      await rename(transaction.livePath, transaction.stagingPath);
      await rename(transaction.rollbackPath, transaction.livePath);
    }
  }

  private validate(transaction: WorkspaceTransaction): void {
    assertChild(this.workspaceRoot, transaction.livePath);
    assertChild(this.transactionsRoot, transaction.transactionPath);
    assertChild(transaction.transactionPath, transaction.stagingPath);
    assertChild(this.rollbackRoot, transaction.rollbackPath);
  }
}
