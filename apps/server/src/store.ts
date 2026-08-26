import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database & { version: number };
      if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = this.migrate(parsed);
      if (parsed.version !== 2) await this.persist(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  private migrate(parsed: Database & { version: number }): Database {
    return {
      version: 2,
      agents: parsed.agents,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      runs: (Array.isArray(parsed.runs) ? parsed.runs : []).map((run) => ({
        ...run,
        proposedThreadId: run.proposedThreadId ?? null,
        policy: run.policy ?? null,
        transaction: run.transaction ?? null,
        changes: run.changes ?? [],
        policyDecision: run.policyDecision ?? null,
        decision: run.decision ?? null,
        auditEvents: run.auditEvents ?? [],
      })),
    };
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
