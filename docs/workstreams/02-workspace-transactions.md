# Workstream 2 — Workspace Transactions and Change Policy

## Objective

Build the transactional workspace boundary. Codex must work on a staging copy,
the real workspace must remain unchanged before approval, and promotion or
discard must be safe and testable.

## Primary ownership

- New `apps/server/src/workspace-transaction.ts`
- New `apps/server/src/change-policy.ts`
- Focused unit and integration tests for these modules
- Minimal coordinated additions to `apps/server/src/workspace.ts`

Do not directly rewrite `AgentService`; Workstream 1 owns orchestration and will
consume the APIs defined here.

## Required implementation

### 1. Transaction storage

Use a layout equivalent to:

```text
workspaces/
├── <agent-id>/
├── .transactions/<run-id>/workspace/
└── .rollback/<run-id>/
```

The transaction directories must never be copied into themselves or exposed as
the parent mount inside the Runtime.

### 2. Transaction API

Implement a small interface equivalent to:

```ts
prepare(runId: string, livePath: string): Promise<WorkspaceTransaction>;
inspect(transaction: WorkspaceTransaction): Promise<FileChange[]>;
promote(transaction: WorkspaceTransaction): Promise<void>;
discard(transaction: WorkspaceTransaction): Promise<void>;
```

`prepare` must record a deterministic digest of the live workspace before
copying it to staging.

### 3. Safe filesystem traversal

- Use canonical absolute paths.
- Validate that every managed path stays under the expected root.
- Use `lstat()` and reject symbolic links for the POC.
- Never rely on a raw string-prefix check.
- Do not use hard links for staging.
- Exclude `.git`, `.codex`, `node_modules`, `dist`, and transaction metadata.

### 4. Change inspection

Return added, modified, and deleted files with bounded metadata:

```ts
interface FileChange {
  path: string;
  kind: "added" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  size: number;
  patch?: string;
}
```

Patches must be optional, text-only, size-limited, and suitable for redaction
before persistence.

### 5. Deterministic change policy

Implement a pure policy evaluator. Hard-deny at least:

- `.env` and `.env.*`
- `.git/**`
- `.codex/**`
- Platform-managed `AGENTS.md`
- Symbolic links
- Escaping or absolute paths
- Credential-like changed content
- Configured file-count and byte limits

Normal source, test, documentation, package, CI, deletion, and rename changes
should produce review evidence rather than being silently promoted.

### 6. Recoverable promotion

Before promotion, recompute the live digest and reject on mismatch. Promote via
a recoverable rename sequence:

```text
live → rollback
staging → live
```

Restore the rollback directory if the second rename fails. Define enough state
for Workstream 1 to reconcile an interrupted promotion on startup.

### 7. Safe discard

Resolve and verify the exact transaction path before recursive deletion. Never
delete a computed path that has not been proven to be under `.transactions`.

## Acceptance criteria

- A fake runner can write to staging without changing the live workspace.
- `inspect` reports accurate additions, modifications, and deletions.
- Approval promotes exactly the inspected staging workspace.
- A changed live digest prevents promotion.
- Rejection removes staging and preserves the live workspace.
- Traversal, symlink, protected-file, and credential fixtures are denied.
- Promotion failure restores the original workspace.

## Non-goals

- Do not invoke an LLM for policy decisions.
- Do not implement Git branches or pull requests.
- Do not implement production-scale binary diffing.
- Do not silently auto-promote source changes in the initial version.

## Handoff

Document the exact transaction and policy return types for Workstream 1. Give
Workstream 5 deterministic fixtures for safe, denied, conflicting, and failed
promotion cases.
