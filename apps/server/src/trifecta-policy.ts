import { rank, type SensitivityLevel } from "./sensitivity.js";
import type { Capability, CapabilityFinding, PolicyRule, TrifectaDecision } from "./types.js";

// The lethal trifecta.
//
// An agent is dangerous when it holds all three of these at once:
//
//   1. private data        - it can read material that must not leak
//   2. untrusted content   - something in its context was written by someone else
//   3. external comms      - it can reach the network
//
// Any two are survivable. All three means untrusted content can instruct the
// agent to read private data and send it out, and no amount of prompt hardening
// reliably prevents that. So the gate does not try to detect the attack; it
// removes one leg of the triangle.
//
// Which leg? Not comms: Codex must reach Ark over the bridge to run at all, and
// Airlock has no Ark-only egress gateway yet (a documented residual risk). Not
// untrusted content: it is already staged and the Run needs it. So the gate
// drops private data — the Run's effective clearance falls to `public`, and the
// ingress gate withholds everything above it. The Run still executes; it just
// cannot both read secrets and talk to the world while handling someone else's
// text.
//
// When an Ark-only egress gateway exists, dropping comms becomes the cheaper
// mitigation and this is where that choice belongs.

const MESSAGES: Record<string, string> = {
  IN060: "This Run held private data, untrusted content, and external network access at the same time.",
  IN061: "Run clearance was lowered to public so the lethal trifecta could not complete.",
  IN062: "The lethal trifecta was present and left unmitigated because the gate is in audit mode.",
};

export interface TrifectaInput {
  requestedClearance: SensitivityLevel;
  /** From the Run policy. Anything other than "none" is external reach. */
  networkMode: string;
  /** Staged files at or above `internal` that the requested clearance would let the Runtime read. */
  readablePrivate: string[];
  /** Staged paths carrying untrusted-provenance or injection signals. */
  untrustedPaths: string[];
  /** Untrusted-content signals found in the prompt itself, such as a URL to fetch. */
  untrustedPrompt: string[];
  enforce: boolean;
}

export function assessTrifecta(input: TrifectaInput): TrifectaDecision {
  const findings: CapabilityFinding[] = [
    {
      capability: "private-data",
      present: input.readablePrivate.length > 0,
      reason: input.readablePrivate.length
        ? input.readablePrivate.length + " staged file(s) at or above internal are readable at clearance " + input.requestedClearance
        : "No staged file above public is readable at this clearance",
      evidence: input.readablePrivate.slice(0, 12),
    },
    {
      capability: "untrusted-content",
      present: input.untrustedPaths.length + input.untrustedPrompt.length > 0,
      reason: input.untrustedPaths.length + input.untrustedPrompt.length
        ? "Content of outside provenance or with injection-shaped text is in scope"
        : "No untrusted-provenance content detected in scope",
      evidence: [...input.untrustedPrompt, ...input.untrustedPaths].slice(0, 12),
    },
    {
      capability: "external-comms",
      present: input.networkMode !== "none",
      reason: input.networkMode === "none"
        ? "The Runtime has no network"
        : "The Runtime reaches the network over " + input.networkMode + ", which is not Ark-only egress",
      evidence: [input.networkMode],
    },
  ];

  const present = findings.filter((finding) => finding.present).map((finding) => finding.capability);
  const complete = present.length === 3;
  const rules: PolicyRule[] = [];
  let effectiveClearance = input.requestedClearance;
  let mitigation: string | null = null;
  let outcome: TrifectaDecision["outcome"] = "safe";

  if (complete) {
    rules.push({ id: "IN060", message: MESSAGES.IN060!, paths: present as string[] });
    if (input.enforce) {
      effectiveClearance = "public";
      mitigation = "Effective clearance lowered from " + input.requestedClearance + " to public for this Run";
      outcome = "mitigated";
      rules.push({ id: "IN061", message: MESSAGES.IN061!, paths: input.readablePrivate.slice(0, 12) });
    } else {
      outcome = "unmitigated";
      rules.push({ id: "IN062", message: MESSAGES.IN062!, paths: [] });
    }
  }

  return { findings, present, outcome, requestedClearance: input.requestedClearance, effectiveClearance, mitigation, rules };
}

export function trifectaSummary(decision: TrifectaDecision): string {
  const held = decision.present.length ? decision.present.join(" + ") : "none";
  const tail = decision.outcome === "mitigated" ? "; " + decision.mitigation : decision.outcome === "unmitigated" ? "; recorded, not mitigated" : "";
  return decision.present.length + " of 3 capabilities held (" + held + ")" + tail;
}

/** Ordered for display: the trifecta reads as a triangle, not a list. */
export const TRIFECTA_ORDER: Capability[] = ["private-data", "untrusted-content", "external-comms"];

export const TRIFECTA_LABELS: Record<Capability, string> = {
  "private-data": "Private data",
  "untrusted-content": "Untrusted content",
  "external-comms": "External comms",
};

/** Kept here so the level ordering used by the gate has a single home. */
export function isPrivate(level: SensitivityLevel): boolean {
  return rank(level) >= rank("internal");
}
