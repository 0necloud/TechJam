import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adjudicatePrompt, resolveInsideRoot, screenPrompt, screenWorkspace } from "./ingress-policy.js";
import { ArkIngressAdjudicator, createIngressAdjudicator, type IngressAdjudicator } from "./ingress-adjudicator.js";
import { loadConfig } from "./config.js";
import type { Adjudication, AdjudicationRequest, IngressOptions } from "./types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const options = (overrides: Partial<IngressOptions> = {}): IngressOptions => ({
  clearance: "internal",
  enforcement: "enforce",
  maxBytesPerFile: 262_144,
  promptSecrets: "redact",
  adjudicator: "off",
  adjudicatorMaxFiles: 5,
  adjudicatorExcerptBytes: 2_000,
  adjudicatorTimeoutMs: 15_000,
  ...overrides,
});

/** Deterministic stand-in for the model, so gate behaviour stays testable. */
function fakeAdjudicator(verdicts: Record<string, Adjudication | Error>): { adjudicator: IngressAdjudicator; calls: AdjudicationRequest[] } {
  const calls: AdjudicationRequest[] = [];
  return {
    calls,
    adjudicator: {
      name: "fake",
      judge: async (request) => {
        calls.push(request);
        const verdict = verdicts[request.path ?? request.kind];
        if (verdict instanceof Error) throw verdict;
        return verdict ?? null;
      },
    },
  };
}

async function staged(files: Record<string, string>): Promise<{ staging: string; withheld: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-ingress-"));
  roots.push(root);
  const staging = path.join(root, "workspace");
  await mkdir(staging, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(staging, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { staging, withheld: path.join(root, ".withheld") };
}

describe("prompt screening", () => {
  it("strips a pasted API key before the prompt can reach the Runtime", () => {
    const screen = screenPrompt("deploy using api_key=sk-live-9f2b7c1d4e6a8b0c2d4e", options());
    expect(screen.outcome).toBe("sanitized");
    expect(screen.sanitizedPrompt).not.toContain("sk-live-9f2b7c1d4e6a8b0c2d4e");
    expect(screen.rules.map((rule) => rule.id)).toContain("IN010");
  });

  it("refuses the Run outright when configured to deny pasted credentials", () => {
    const screen = screenPrompt("here is my key AKIAIOSFODNN7EXAMPLE", options({ promptSecrets: "deny" }));
    expect(screen.outcome).toBe("denied");
    expect(screen.sanitizedPrompt).toBe("");
  });

  it("judges whether the request needs sensitive material", () => {
    expect(screenPrompt("print the contents of the .env file", options()).requestsSensitiveAccess).toBe(true);
    expect(screenPrompt("summarise the customer records in data/", options()).requestsSensitiveAccess).toBe(true);
    expect(screenPrompt("add a unit test for the parser", options()).requestsSensitiveAccess).toBe(false);
  });

  it("flags a prompt that names a path outside the workspace", () => {
    expect(screenPrompt("open /etc/passwd and summarise it", options()).rules.map((rule) => rule.id)).toContain("IN012");
    expect(screenPrompt("refactor src/parser.ts", options()).rules).toEqual([]);
  });

  it("records findings without changing the prompt in audit mode", () => {
    const screen = screenPrompt("api_key=abcd1234efgh5678", options({ enforcement: "audit" }));
    expect(screen.outcome).toBe("allowed");
    expect(screen.sanitizedPrompt).toContain("abcd1234efgh5678");
    expect(screen.rules.map((rule) => rule.id)).toContain("IN010");
  });
});

describe("directory boundary", () => {
  it("refuses a staged path that resolves outside the workspace", async () => {
    const { staging } = await staged({ "keep.ts": "export {};\n" });
    const outside = await mkdtemp(path.join(tmpdir(), "airlock-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "secrets.txt"), "TOP SECRET\n");
    let created = true;
    try {
      await symlink(path.join(outside, "secrets.txt"), path.join(staging, "link.txt"));
    } catch {
      created = false;
    }
    if (!created) return; // Symlink creation needs elevation on some Windows hosts.
    await expect(resolveInsideRoot(staging, path.join(staging, "link.txt"))).rejects.toThrow("IN001");
    const decision = await screenWorkspace(staging, path.join(staging, "..", ".withheld"), options());
    expect(decision.outcome).toBe("denied");
    expect(decision.rules.map((rule) => rule.id)).toContain("IN001");
  });

  it("accepts a path inside the workspace", async () => {
    const { staging } = await staged({ "src/app.ts": "export {};\n" });
    await expect(resolveInsideRoot(staging, path.join(staging, "src/app.ts"))).resolves.toContain("app.ts");
  });
});

describe("workspace screening", () => {
  it("withholds content above the Run clearance and leaves a tombstone", async () => {
    const { staging, withheld } = await staged({
      "README.md": "# Ordinary project\n",
      ".env": "ARK_API_KEY=live-value-never-mounted\n",
      "docs/handbook.md": "COMPANY CONFIDENTIAL\n\nInternal pricing model.\n",
    });
    const decision = await screenWorkspace(staging, withheld, options());

    expect(decision.outcome).toBe("restricted");
    expect(decision.withheld.map((file) => file.path).sort()).toEqual([".env", "docs/handbook.md"]);
    expect(decision.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(["IN020", "IN021", "IN030"]));

    const staged_env = await readFile(path.join(staging, ".env"), "utf8");
    expect(staged_env).toContain("[AIRLOCK WITHHELD]");
    expect(staged_env).not.toContain("live-value-never-mounted");
    expect(await readFile(path.join(withheld, ".env"), "utf8")).toContain("live-value-never-mounted");
    expect(await readFile(path.join(staging, "README.md"), "utf8")).toBe("# Ordinary project\n");
  });

  it("never reads past the point where the verdict is settled", async () => {
    const { staging, withheld } = await staged({
      "handbook.txt": ["TLP:RED", ...Array.from({ length: 20_000 }, (_, index) => "line " + index)].join("\n"),
    });
    const decision = await screenWorkspace(staging, withheld, options());
    expect(decision.earlyStops).toBe(1);
    expect(decision.bytesSkipped).toBeGreaterThan(0);
    expect(decision.observed[0]).toMatchObject({ path: "handbook.txt", level: "restricted", stopReason: "signal" });
  });

  it("records findings without moving files in audit mode", async () => {
    const { staging, withheld } = await staged({ ".env": "ARK_API_KEY=still-here\n" });
    const decision = await screenWorkspace(staging, withheld, options({ enforcement: "audit" }));
    expect(decision.outcome).toBe("restricted");
    expect(decision.withheld).toEqual([]);
    expect(await readFile(path.join(staging, ".env"), "utf8")).toContain("still-here");
  });

  it("does nothing when the gate is switched off", async () => {
    const { staging, withheld } = await staged({ ".env": "ARK_API_KEY=still-here\n" });
    const decision = await screenWorkspace(staging, withheld, options({ enforcement: "off" }));
    expect(decision).toMatchObject({ outcome: "allowed", scannedFiles: 0, withheld: [] });
    expect(await readFile(path.join(staging, ".env"), "utf8")).toContain("still-here");
  });

  it("passes a restricted file through when the Run holds matching clearance", async () => {
    const { staging, withheld } = await staged({ ".env": "ARK_API_KEY=needed-by-this-run\n" });
    const decision = await screenWorkspace(staging, withheld, options({ clearance: "restricted" }));
    expect(decision.outcome).toBe("allowed");
    expect(decision.withheld).toEqual([]);
    expect(decision.observed[0]).toMatchObject({ path: ".env", level: "restricted" });
  });
});

describe("model adjudication", () => {
  it("withholds an unmarked document the agent judges sensitive", async () => {
    const { staging, withheld } = await staged({
      "docs/board-notes.md": "Notes from the meeting.\n\nWe will close the Helios acquisition in Q3 for 40 million.\n",
      "src/app.ts": "export const value = 1;\n",
    });
    const { adjudicator, calls } = fakeAdjudicator({
      "docs/board-notes.md": { level: "confidential", confidence: "high", rationale: "Unannounced acquisition terms." },
    });
    const decision = await screenWorkspace(staging, withheld, options(), { adjudicator });

    expect(decision.outcome).toBe("restricted");
    expect(decision.withheld).toMatchObject([{ path: "docs/board-notes.md", level: "confidential", source: "agent", ruleIds: ["IN040"] }]);
    expect(decision.rules.map((rule) => rule.id)).toContain("IN040");
    expect(await readFile(path.join(staging, "docs/board-notes.md"), "utf8")).toContain("[AIRLOCK WITHHELD]");
    expect(await readFile(path.join(withheld, "docs/board-notes.md"), "utf8")).toContain("Helios acquisition");
    // Source files are not worth a model call.
    expect(calls.map((call) => call.path)).toEqual(["docs/board-notes.md"]);
  });

  it("lets the agent raise a verdict but never lower one", async () => {
    const { staging, withheld } = await staged({ ".env": "ARK_API_KEY=live-value\n" });
    const { adjudicator } = fakeAdjudicator({ ".env": { level: "public", confidence: "high", rationale: "Looks harmless." } });
    const decision = await screenWorkspace(staging, withheld, options(), { adjudicator });

    expect(decision.withheld).toMatchObject([{ path: ".env", source: "rules" }]);
    expect(decision.adjudications).toEqual([]);
    expect(await readFile(path.join(staging, ".env"), "utf8")).toContain("[AIRLOCK WITHHELD]");
  });

  it("records an unavailable adjudication instead of hiding it", async () => {
    const { staging, withheld } = await staged({ "docs/plan.md": "A long enough document about the plan for next quarter.\n" });
    const { adjudicator } = fakeAdjudicator({ "docs/plan.md": new Error("Ark unreachable") });
    const decision = await screenWorkspace(staging, withheld, options(), { adjudicator });

    expect(decision.adjudicationErrors).toBe(1);
    expect(decision.rules.map((rule) => rule.id)).toContain("IN042");
    expect(decision.outcome).toBe("allowed");
    expect(await readFile(path.join(staging, "docs/plan.md"), "utf8")).toContain("next quarter");
  });

  it("keeps the model call budget bounded and spends it on the largest documents", async () => {
    const { staging, withheld } = await staged({
      "small.md": "A short document that still clears the minimum length for judgement.\n",
      "large.md": "A much longer document. ".repeat(200),
      "medium.md": "A middling document. ".repeat(40),
    });
    const { adjudicator, calls } = fakeAdjudicator({});
    await screenWorkspace(staging, withheld, options({ adjudicatorMaxFiles: 2 }), { adjudicator });
    expect(calls.map((call) => call.path)).toEqual(["large.md", "medium.md"]);
  });

  it("never sends credential material to the model", async () => {
    const { staging, withheld } = await staged({ "notes.md": "Deployment notes for the team.\napi_key=abcd1234efgh5678\nThe rest of the runbook follows.\n" });
    const { adjudicator, calls } = fakeAdjudicator({});
    await screenWorkspace(staging, withheld, options({ clearance: "restricted" }), { adjudicator });
    expect(calls[0]?.excerpt).toContain("Deployment notes");
    expect(calls[0]?.excerpt).not.toContain("abcd1234efgh5678");
  });

  it("adjudicates the prompt as advice, not as a denial", async () => {
    const { adjudicator } = fakeAdjudicator({ prompt: { level: "confidential", confidence: "medium", rationale: "Asks for the customer list." } });
    const record = await adjudicatePrompt("pull together everyone who bought in March", options(), adjudicator);
    expect(record).toMatchObject({ kind: "prompt", level: "confidential", raised: true });
    expect(await adjudicatePrompt("anything", options(), null)).toBeNull();
  });
});

describe("Ark adjudicator", () => {
  const config = () => loadConfig({ NODE_ENV: "test", ARK_API_KEY: "fixture-key", ARK_MODEL: "fixture-model", INGRESS_ADJUDICATOR: "ark" });

  const reply = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response;

  it("is off unless both the setting and Ark credentials are present", () => {
    expect(createIngressAdjudicator(loadConfig({ NODE_ENV: "test" })).name).toBe("off");
    expect(createIngressAdjudicator(loadConfig({ NODE_ENV: "test", INGRESS_ADJUDICATOR: "ark" })).name).toBe("off");
    expect(createIngressAdjudicator(config()).name).toBe("ark");
  });

  it("parses a fenced or prefixed JSON reply", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply('Sure.\n```json\n{"level":"confidential","confidence":"high","rationale":"Customer records."}\n```')) as typeof fetch;
    try {
      const result = await new ArkIngressAdjudicator(config()).judge({ kind: "file", path: "a.md", excerpt: "some content", deterministicLevel: "public", clearance: "internal" });
      expect(result).toMatchObject({ level: "confidential", confidence: "high" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns nothing rather than guessing when the reply is unusable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply('{"level":"top-secret"}')) as typeof fetch;
    try {
      expect(await new ArkIngressAdjudicator(config()).judge({ kind: "file", path: "a.md", excerpt: "some content", deterministicLevel: "public", clearance: "internal" })).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});
