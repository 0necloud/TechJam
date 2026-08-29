import type { AppConfig } from "./config.js";
import { redactSecrets } from "./sensitivity.js";
import type { Adjudication, AdjudicationRequest, SensitivityLevel } from "./types.js";

// The model-backed half of the ingress gate.
//
// Deterministic rules catch what can be named: a `.env`, an `AKIA...`, a
// `CONFIDENTIAL` banner. They cannot read a document that is sensitive because
// of what it *says* — an unmarked board memo, a customer list with no header, a
// design doc naming an unannounced product. That judgement is what a model is
// for, so the gate delegates exactly those cases and nothing else.
//
// Two properties make an unreliable judge safe to use here:
//
//   1. It only ever raises. `screenWorkspace` takes the maximum of the
//      deterministic level and the adjudicated level, so the model can add a
//      restriction and can never lift one. A hallucinated "public" changes
//      nothing.
//   2. It runs in the control plane, on a bounded and secret-redacted excerpt,
//      never inside the Runtime and never with the workspace attached.
//
// It is off by default. Enabling it sends excerpts of staged content to the Ark
// model, which is a real trade and has to be chosen deliberately.

const LEVELS = new Set<SensitivityLevel>(["public", "internal", "confidential", "restricted"]);

export interface IngressAdjudicator {
  readonly name: string;
  judge(request: AdjudicationRequest): Promise<Adjudication | null>;
}

export class NullIngressAdjudicator implements IngressAdjudicator {
  readonly name = "off";
  async judge(): Promise<Adjudication | null> { return null; }
}

const SYSTEM_PROMPT = [
  "You classify material for a security gate that decides what an autonomous coding agent is allowed to read.",
  "Return only JSON: {\"level\":\"public|internal|confidential|restricted\",\"confidence\":\"low|medium|high\",\"rationale\":\"one short sentence\"}.",
  "",
  "level meanings:",
  "- public: ordinary source code, docs, configuration, tests, build output.",
  "- internal: business material not meant to leave the organisation.",
  "- confidential: unreleased plans, financials, legal matters, customer or employee records, personal data.",
  "- restricted: credentials, keys, tokens, or anything explicitly marked secret.",
  "",
  "Judge the substance, not the wording. A file that merely discusses security is public.",
  "Prefer the lower level when genuinely unsure, and say so with low confidence.",
].join("\n");

function userPrompt(request: AdjudicationRequest): string {
  const header = request.kind === "prompt"
    ? "Classify the sensitivity of the material this request would need the agent to read."
    : "Classify the sensitivity of this file's content. File name: " + (request.path ?? "unknown");
  return [header, "Deterministic rules already assigned: " + request.deterministicLevel + ".", "", "---", request.excerpt, "---"].join("\n");
}

/** Pulls the first JSON object out of a reply that may be fenced or prefixed. */
function parseAdjudication(content: string): Adjudication | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const value = parsed as { level?: unknown; confidence?: unknown; rationale?: unknown };
  if (typeof value.level !== "string" || !LEVELS.has(value.level as SensitivityLevel)) return null;
  const confidence = value.confidence === "high" || value.confidence === "medium" ? value.confidence : "low";
  return {
    level: value.level as SensitivityLevel,
    confidence,
    rationale: typeof value.rationale === "string" ? value.rationale.slice(0, 300) : "",
  };
}

export class ArkIngressAdjudicator implements IngressAdjudicator {
  readonly name = "ark";

  constructor(private readonly config: AppConfig) {}

  async judge(request: AdjudicationRequest): Promise<Adjudication | null> {
    const excerpt = redactSecrets(request.excerpt).slice(0, this.config.ingress.adjudicatorExcerptBytes);
    if (!excerpt.trim()) return null;
    const response = await fetch(this.config.arkBaseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + this.config.arkApiKey },
      body: JSON.stringify({
        model: this.config.arkModel,
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt({ ...request, excerpt }) },
        ],
      }),
      signal: AbortSignal.timeout(this.config.ingress.adjudicatorTimeoutMs),
    });
    if (!response.ok) throw new Error("Ark adjudication failed with status " + response.status);
    const payload = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === "string" ? parseAdjudication(content) : null;
  }
}

export function createIngressAdjudicator(config: AppConfig): IngressAdjudicator {
  if (config.ingress.adjudicator !== "ark") return new NullIngressAdjudicator();
  if (!config.arkApiKey || !config.arkModel) return new NullIngressAdjudicator();
  return new ArkIngressAdjudicator(config);
}
