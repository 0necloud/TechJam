import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  classifyFile,
  classifyText,
  highest,
  levelAbove,
  rank,
  redactSecrets,
  type FileSensitivity,
  type SensitivityLevel,
} from "./sensitivity.js";
import type { IngressAdjudicator } from "./ingress-adjudicator.js";
import { assessTrifecta, isPrivate } from "./trifecta-policy.js";
import type {
  Adjudication,
  AdjudicationRecord,
  IngressDecision,
  IngressOptions,
  IngressSource,
  PolicyRule,
  PromptScreen,
  WithheldFile,
} from "./types.js";

// The Airlock ingress gate. Three enforcement points, in the order a Run meets
// them:
//
//   1. `screenPrompt`   - before anything is staged, decide whether the request
//                         itself carries or asks for sensitive material.
//   2. `resolveInsideRoot` - the directory boundary: every path the gate touches
//                         is resolved through symlinks and proved to sit inside
//                         the Run's staging root.
//   3. `screenWorkspace` - classify each staged file and withhold anything above
//                         the Run's clearance, before the container starts.
//
// There is no fourth point inside the container. Codex reads its bind mount with
// ordinary syscalls, so a read that has already begun cannot be interrupted. The
// gate compensates by making sure the bytes were never mounted.

const EXCLUDED = new Set([".git", ".codex", "node_modules", "dist", ".transactions", ".rollback", ".deleted", ".withheld"]);
const MAX_OBSERVED = 50;

export const INGRESS_MESSAGES: Record<string, string> = {
  IN001: "A staged path resolves outside the Run's workspace directory.",
  IN010: "The prompt contains credential material and was sanitized before it reached the Runtime.",
  IN011: "The prompt asks the Agent to read or transmit sensitive material.",
  IN012: "The prompt names a path outside the Agent's workspace directory.",
  IN020: "A file name identifies it as a credential or key store.",
  IN021: "A document carries a security classification marking.",
  IN022: "File content contains credential material.",
  IN023: "File content contains personal data.",
  IN025: "A file name declares the content sensitive.",
  IN030: "Content above the Run's clearance was withheld from the Runtime.",
  IN040: "The ingress adjudicator judged this content sensitive despite no deterministic rule matching.",
  IN041: "The ingress adjudicator judged this request to need material above the Run's clearance.",
  IN042: "An adjudication could not be obtained; the deterministic verdict stands for this file.",
  IN050: "Staged content came from outside this workspace and is treated as untrusted input.",
  IN051: "The prompt points the Agent at content from outside the workspace.",
  IN052: "Staged content contains prompt-injection phrasing.",
  IN060: "This Run held private data, untrusted content, and external network access at the same time.",
  IN061: "Run clearance was lowered to public so the lethal trifecta could not complete.",
  IN062: "The lethal trifecta was present and left unmitigated because the gate is in audit mode.",
};

function rulesFrom(entries: Iterable<[string, Iterable<string>]>): PolicyRule[] {
  return [...entries].map(([id, paths]) => ({ id, message: INGRESS_MESSAGES[id] ?? id, paths: [...new Set(paths)].slice(0, 64) }));
}

// --- 1. Prompt screening ----------------------------------------------------

// "Does this request need sensitive material?" is answered from the request
// alone, before any file is opened, so a Run that has no business reading
// credentials can be flagged for review at the moment it is submitted.
const SENSITIVE_SUBJECT = /\b(?:\.env|env(?:ironment)?\s+(?:file|variable)s?|api[\s_-]?keys?|secrets?|credentials?|passwords?|passphrases?|private\s+keys?|ssh\s+keys?|access\s+tokens?|certificates?|payroll|salary|salaries|nric|ssn|social\s+security|customer\s+(?:data|records?)|personal\s+data|pii|classified|confidential)\b/i;
const ACCESS_VERB = /\b(?:read|open|cat|show|print|display|reveal|dump|echo|list|inspect|grep|search|find|load|parse|summari[sz]e|extract|send|upload|post|publish|share|email|transmit|exfiltrate|leak)\b/i;
const PATH_ESCAPE = /(?:^|[\s"'`(=])(?:\.\.[\\/]|~[\\/]|\/(?:etc|root|proc|sys|var|usr|home|Users)\/|[A-Za-z]:[\\/])/;

// A URL in the prompt means the Run intends to pull in text nobody here wrote:
// leg two of the trifecta arrives by instruction, not by staging.
const EXTERNAL_REFERENCE = /\bhttps?:\/\/[^\s"'<>)]+/gi;

export function screenPrompt(prompt: string, options: Pick<IngressOptions, "enforcement" | "promptSecrets">): PromptScreen {
  if (options.enforcement === "off") {
    return { outcome: "allowed", sanitizedPrompt: prompt, requestsSensitiveAccess: false, untrustedReferences: [], rules: [] };
  }
  const found = new Map<string, string[]>();
  const secrets = classifyText(prompt, "content").filter((signal) => signal.rule === "IN022");
  if (secrets.length) found.set("IN010", secrets.map((signal) => signal.detail));
  const requestsSensitiveAccess = SENSITIVE_SUBJECT.test(prompt) && ACCESS_VERB.test(prompt);
  if (requestsSensitiveAccess) found.set("IN011", [SENSITIVE_SUBJECT.exec(prompt)?.[0] ?? "sensitive subject"]);
  const escape = PATH_ESCAPE.exec(prompt);
  if (escape) found.set("IN012", [escape[0].trim()]);
  const untrustedReferences = [...new Set(prompt.match(EXTERNAL_REFERENCE) ?? [])].slice(0, 8);
  if (untrustedReferences.length) found.set("IN051", untrustedReferences);

  const rules = rulesFrom(found);
  const base = { requestsSensitiveAccess, untrustedReferences, rules };
  if (!secrets.length) return { outcome: "allowed", sanitizedPrompt: prompt, ...base };
  if (options.promptSecrets === "deny" && options.enforcement === "enforce") {
    return { outcome: "denied", sanitizedPrompt: "", ...base };
  }
  const sanitizedPrompt = options.enforcement === "enforce" ? redactSecrets(prompt) : prompt;
  return { outcome: options.enforcement === "enforce" ? "sanitized" : "allowed", sanitizedPrompt, ...base };
}

// --- 2. Directory boundary --------------------------------------------------

/**
 * Resolves `candidate` through symlinks and proves it stays inside `root`.
 * Throws with rule IN001 when it escapes, so a symlinked `/etc` or a link into
 * another Agent's workspace is refused before it can be classified or mounted.
 */
export async function resolveInsideRoot(root: string, candidate: string): Promise<string> {
  const resolvedRoot = await realpath(root);
  const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) {
    throw new Error("IN001: " + INGRESS_MESSAGES.IN001 + " (" + path.basename(candidate) + ")");
  }
  return resolved;
}

// --- 3. Workspace screening -------------------------------------------------

function tombstoneFor(file: FileSensitivity, clearance: SensitivityLevel, reason: string, ruleIds: string[]): string {
  return [
    "[AIRLOCK WITHHELD]",
    "",
    "This file exists in the Agent workspace but its content was withheld from",
    "the Runtime by the Airlock ingress gate. The original bytes were never",
    "mounted and were never read by the model.",
    "",
    "Path:           " + file.path,
    "Classification: " + file.level + " (Run clearance: " + clearance + ")",
    "Rules:          " + ruleIds.join(", "),
    "Reason:         " + reason,
    "",
    "Ask the operator to raise the Run clearance if this file is required.",
    "",
  ].join("\n");
}

async function* walk(root: string, directory: string): AsyncGenerator<{ absolute: string; relative: string }> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED.has(item.name)) continue;
    const absolute = path.join(directory, item.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (item.isDirectory()) yield* walk(root, absolute);
    else yield { absolute, relative };
  }
}

/**
 * Classifies every staged file and, in `enforce` mode, moves anything above the
 * Run's clearance out of the staging tree into `withheldRoot` before the
 * container is started. The original is kept so an approved Run can restore it
 * during promotion; the live workspace is never touched.
 */
export async function screenWorkspace(
  stagingRoot: string,
  withheldRoot: string,
  options: IngressOptions,
  context: ScreenContext = {},
): Promise<IngressDecision> {
  const adjudicator = context.adjudicator ?? null;
  const networkMode = context.networkMode ?? "current-bridge";
  const decision: IngressDecision = {
    outcome: "allowed",
    clearance: options.clearance,
    effectiveClearance: options.clearance,
    enforcement: options.enforcement,
    scannedFiles: 0,
    bytesInspected: 0,
    bytesSkipped: 0,
    earlyStops: 0,
    withheld: [],
    observed: [],
    rules: [],
    adjudicator: adjudicator?.name ?? "off",
    adjudications: [],
    adjudicationErrors: 0,
    trifecta: null,
  };
  if (options.enforcement === "off") return decision;

  // The abort threshold has to assume the worst case, because the trifecta may
  // lower clearance to public after the walk: read no further than a `public`
  // verdict needs.
  const abortAt = levelAbove("public");
  const found = new Map<string, string[]>();
  const add = (id: string, file: string) => found.set(id, [...(found.get(id) ?? []), file]);
  const captureExcerpt = adjudicator ? options.adjudicatorExcerptBytes : 0;

  /** Moves a file out of staging and leaves a tombstone the Runtime can read. */
  const withhold = async (absolute: string, file: FileSensitivity, source: IngressSource, reason: string, ruleIds: string[]) => {
    if (options.enforcement === "audit") {
      add("IN030", file.path);
      if (decision.outcome === "allowed") decision.outcome = "restricted";
      return;
    }
    const quarantine = path.join(withheldRoot, file.path);
    await mkdir(path.dirname(quarantine), { recursive: true });
    await rename(absolute, quarantine);
    const tombstone = tombstoneFor(file, decision.effectiveClearance, reason, ruleIds);
    await writeFile(absolute, tombstone, { encoding: "utf8", mode: 0o600 });
    decision.withheld.push({
      path: file.path,
      level: file.level,
      ruleIds,
      reason,
      bytesInspected: file.bytesInspected,
      size: file.size,
      tombstoneHash: createHash("sha256").update(tombstone).digest("hex"),
      source,
    });
    add("IN030", file.path);
    if (decision.outcome === "allowed") decision.outcome = "restricted";
  };

  // Pass one: classify everything, withhold nothing yet. The trifecta check
  // needs the whole picture — what is private and what is untrusted — before it
  // can decide which clearance the Run is actually allowed to hold.
  const classified: { absolute: string; file: FileSensitivity }[] = [];
  const untrustedPaths: string[] = [];
  for await (const entry of walk(stagingRoot, stagingRoot)) {
    const info = await lstat(entry.absolute);
    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = await resolveInsideRoot(stagingRoot, entry.absolute);
      } catch {
        add("IN001", entry.relative);
        // Audit mode observes; only an enforcing gate fails the Run closed.
        if (options.enforcement === "enforce") decision.outcome = "denied";
        else if (decision.outcome === "allowed") decision.outcome = "restricted";
        continue;
      }
      // A link to a directory inside staging has nothing to classify.
      if (!(await stat(target).then((linked) => linked.isFile()).catch(() => false))) continue;
    } else if (!info.isFile()) continue;
    const file = await classifyFile(entry.absolute, entry.relative, { maxBytes: options.maxBytesPerFile, abortAt, captureExcerpt });
    decision.scannedFiles += 1;
    decision.bytesInspected += file.bytesInspected;
    decision.bytesSkipped += Math.max(0, file.size - file.bytesInspected);
    if (file.stopReason === "signal" || file.stopReason === "name-only") decision.earlyStops += 1;
    for (const signal of file.signals) add(signal.rule, file.path);
    for (const signal of file.provenance) add(signal.rule, file.path);
    if (file.provenance.length) untrustedPaths.push(file.path);
    if (rank(file.level) >= rank("internal")) observe(decision, file, [...new Set(file.signals.map((signal) => signal.rule))], "rules");
    classified.push({ absolute: entry.absolute, file });
  }

  // The trifecta check. If the Run would hold private data, untrusted content,
  // and network reach at once, clearance drops to public and the withholding
  // below enforces it.
  const trifecta = assessTrifecta({
    requestedClearance: options.clearance,
    networkMode,
    readablePrivate: classified.filter((entry) => isPrivate(entry.file.level) && rank(entry.file.level) <= rank(options.clearance)).map((entry) => entry.file.path),
    untrustedPaths,
    untrustedPrompt: context.untrustedPrompt ?? [],
    enforce: options.enforcement === "enforce",
  });
  decision.trifecta = trifecta;
  decision.effectiveClearance = trifecta.effectiveClearance;
  if (trifecta.outcome !== "safe" && decision.outcome === "allowed") decision.outcome = "restricted";

  // Pass two: withhold everything above the clearance the Run is actually
  // allowed to hold. What survives becomes the candidate pool for the model, so
  // the expensive judgement only sees what the cheap one could not decide.
  const candidates: { absolute: string; file: FileSensitivity }[] = [];
  for (const entry of classified) {
    const ruleIds = [...new Set(entry.file.signals.map((signal) => signal.rule))];
    if (rank(entry.file.level) > rank(decision.effectiveClearance)) {
      const trifectaDrop = rank(entry.file.level) <= rank(options.clearance);
      await withhold(
        entry.absolute,
        entry.file,
        "rules",
        trifectaDrop ? "Lethal trifecta mitigation: " + trifecta.mitigation : [...new Set(entry.file.signals.map((signal) => signal.detail))].join("; "),
        trifectaDrop ? [...ruleIds, "IN061"] : ruleIds,
      );
    } else if (adjudicator && isAdjudicable(entry.file)) {
      candidates.push(entry);
    }
  }

  // Pass two: the model judges the largest surviving documents, within a fixed
  // call budget. It can only raise a level, so a wrong answer costs an extra
  // review, never a leak.
  if (adjudicator) {
    const budget = candidates.sort((left, right) => right.file.size - left.file.size).slice(0, options.adjudicatorMaxFiles);
    for (const candidate of budget) {
      let judgement: Adjudication | null = null;
      try {
        judgement = await adjudicator.judge({ kind: "file", path: candidate.file.path, excerpt: candidate.file.excerpt ?? "", deterministicLevel: candidate.file.level, clearance: options.clearance });
      } catch {
        decision.adjudicationErrors += 1;
        add("IN042", candidate.file.path);
        continue;
      }
      if (!judgement) continue;
      const raised = rank(judgement.level) > rank(candidate.file.level);
      decision.adjudications.push({ kind: "file", target: candidate.file.path, deterministicLevel: candidate.file.level, level: judgement.level, confidence: judgement.confidence, rationale: judgement.rationale, raised });
      if (!raised || rank(judgement.level) <= rank(decision.effectiveClearance)) continue;
      const promoted: FileSensitivity = { ...candidate.file, level: judgement.level };
      add("IN040", candidate.file.path);
      observe(decision, promoted, ["IN040"], "agent");
      await withhold(candidate.absolute, promoted, "agent", judgement.rationale || "Judged " + judgement.level + " by the ingress adjudicator", ["IN040"]);
    }
  }

  decision.rules = [...rulesFrom(found), ...trifecta.rules];
  return decision;
}

export interface ScreenContext {
  adjudicator?: IngressAdjudicator | null;
  /** From the Run policy. Decides whether the Runtime holds external reach. */
  networkMode?: string;
  /** Untrusted-content signals already found in the prompt. */
  untrustedPrompt?: string[];
}

function observe(decision: IngressDecision, file: FileSensitivity, ruleIds: string[], source: IngressSource): void {
  if (decision.observed.length >= MAX_OBSERVED) return;
  decision.observed.push({ path: file.path, level: file.level, ruleIds, stopReason: file.stopReason, bytesInspected: file.bytesInspected, size: file.size, source });
}

// Prose and documents are worth a model call; source files, lockfiles, and
// build output are not, and spending the budget on them would starve the
// documents that actually carry unmarked sensitivity.
const ADJUDICABLE = /\.(?:md|markdown|txt|rst|csv|tsv|log|html?|pdf|docx|docm|xlsx|xlsm|pptx|pptm|odt|ods|odp|eml|msg)$/i;
const MIN_ADJUDICABLE_CHARS = 40;

function isAdjudicable(file: FileSensitivity): boolean {
  return ADJUDICABLE.test(file.path) && (file.excerpt ?? "").trim().length >= MIN_ADJUDICABLE_CHARS;
}

/**
 * Asks the adjudicator whether the request itself needs material above the Run's
 * clearance. Advisory: it records a finding, and never denies on its own.
 */
export async function adjudicatePrompt(prompt: string, options: IngressOptions, adjudicator: IngressAdjudicator | null): Promise<AdjudicationRecord | null> {
  if (!adjudicator || options.enforcement === "off") return null;
  const judgement = await adjudicator.judge({ kind: "prompt", excerpt: prompt, deterministicLevel: "public", clearance: options.clearance });
  if (!judgement) return null;
  return { kind: "prompt", target: "prompt", deterministicLevel: "public", level: judgement.level, confidence: judgement.confidence, rationale: judgement.rationale, raised: rank(judgement.level) > rank(options.clearance) };
}

export function ingressSummary(decision: IngressDecision): string {
  const level = highest(decision.observed.map((entry) => entry.level));
  const agentRaised = decision.adjudications.filter((record) => record.raised).length;
  return [
    decision.scannedFiles + " staged file(s) classified",
    "highest " + level,
    decision.withheld.length + " withheld",
    decision.earlyStops + " read(s) stopped early",
    Math.round(decision.bytesSkipped / 1024) + " KiB never read",
    "adjudicator " + decision.adjudicator + (decision.adjudicator === "off" ? "" : " (" + decision.adjudications.length + " judged, " + agentRaised + " raised, " + decision.adjudicationErrors + " unavailable)"),
  ].join(", ");
}
