// Airlock contribution registry.
//
// Every entry is a surface this team added on top of the Volc Agent Launchpad
// starter kit. The "What we built" toggle in the Playground reads this list to
// number each surface and explain which module backs it, so a reviewer can tell
// our work apart from the baseline without reading the diff.
//
// Line counts come from `git diff 7c6fbbe..HEAD` against the starter kit commit.

export interface Contribution {
  /** Badge number rendered on the surface and in the index. */
  id: number;
  title: string;
  /** What this surface proves, in one reviewer-facing sentence. */
  blurb: string;
  /** Repository path of the module that backs the surface. */
  file: string;
  /** Lines added to that module, and whether the file is new. */
  lines: number;
  isNewFile: boolean;
}

export const contributions: Contribution[] = [
  {
    id: 1,
    title: "Quarantine verdict",
    blurb:
      "Every turn lands in a staging copy first. The headline states whether changes are held for review, denied outright, or already promoted.",
    file: "apps/server/src/change-policy.ts",
    lines: 53,
    isNewFile: true,
  },
  {
    id: 2,
    title: "Capability-scoped Run and egress policy",
    blurb:
      "Each Run gets an expiring policy naming its runtime, workspace, session, and network scope. In gateway mode the Runtime receives a signed Run token—not the Ark key—and can reach only the Responses gateway on an internal network.",
    file: "apps/server/src/run-policy.ts",
    lines: 33,
    isNewFile: true,
  },
  {
    id: 3,
    title: "Live workspace proof",
    blurb:
      "The live workspace is digested before the Run and re-checked at review time, so promotion is refused when anything drifted underneath.",
    file: "apps/server/src/workspace-transaction.ts",
    lines: 174,
    isNewFile: true,
  },
  {
    id: 4,
    title: "Deterministic policy rules",
    blurb:
      "TC001, TC002, and TC100 are code, not prompt filtering. Protected names are matched on every path segment, so config/.env is denied as firmly as .env.",
    file: "apps/server/src/change-policy.ts",
    lines: 53,
    isNewFile: true,
  },
  {
    id: 5,
    title: "Proposed change set",
    blurb:
      "Per-file kind, size, before/after hashes, and a unified diff — computed from the staging tree, never from the model's own account of what it did.",
    file: "apps/server/src/workspace-transaction.ts",
    lines: 174,
    isNewFile: true,
  },
  {
    id: 6,
    title: "Audit timeline",
    blurb:
      "An ordered, persisted record of the Run: created, policy issued, container exited, policy evaluated, decision taken.",
    file: "apps/server/src/audit-recorder.ts",
    lines: 18,
    isNewFile: true,
  },
  {
    id: 7,
    title: "Human promotion gate",
    blurb:
      "Approve promotes files and the proposed Codex thread together. Reject discards staging and resets session state. Nothing reaches the live workspace without this click.",
    file: "apps/server/src/agent-service.ts",
    lines: 154,
    isNewFile: false,
  },
  {
    id: 8,
    title: "Read-side ingress gate",
    blurb:
      "Deterministic rules classify every staged file, then an optional model adjudicator judges the documents the rules could not settle. It can only raise a verdict, never lower one. Anything above clearance is pulled out of staging before the container starts, so a marked document or a .env is never mounted — not merely never promoted.",
    file: "apps/server/src/ingress-policy.ts",
    lines: 264,
    isNewFile: true,
  },
  {
    id: 9,
    title: "Lethal-trifecta capability check",
    blurb:
      "An agent is dangerous only when it holds private data, untrusted content, and external comms at once. The gate assesses all three per Run and, when the set completes, drops private data — clearance falls to public and the sensitive material is withheld. The Run still executes.",
    file: "apps/server/src/trifecta-policy.ts",
    lines: 118,
    isNewFile: true,
  },
];

/** Totals shown in the index header. */
export const contributionSummary = {
  newModules: 4,
  linesAdded: 1682,
  surfaces: contributions.length,
  baselineCommit: "7c6fbbe",
};
