# Workstream 1 — Control Plane, Data Model, and API

## Objective

Own the Run lifecycle and the server-side contract that connects all other
workstreams. The result should let `AgentService` create a guarded Run, wait for
review, and accept an approval or rejection without breaking existing Agent
CRUD or Playground behavior.

## Primary ownership

- `apps/server/src/types.ts`
- `apps/server/src/store.ts`
- `apps/server/src/agent-service.ts`
- `apps/server/src/app.ts`
- Relevant server unit tests

Coordinate before changing runner, transaction, audit, or frontend files owned
by other workstreams.

## Required implementation

### 1. Extend lifecycle types

Add:

- Agent status: `review`
- Run statuses: `awaiting_review` and `rejected`
- `proposedThreadId`
- Run policy summary
- Change-set summary
- Human decision metadata
- Audit-event types agreed with Workstream 4

The shared types must be agreed early because every other workstream consumes
them.

### 2. Migrate persisted data

Upgrade the JSON database schema without destroying existing Agents, messages,
or Runs. Old records should receive safe defaults for new fields.

### 3. Orchestrate the guarded Run

Update `AgentService.executeRun()` to follow this sequence:

1. Create a per-Run policy using the Workstream 3 contract.
2. Prepare a staging workspace using the Workstream 2 contract.
3. Pass the staging path, private Codex home, and policy to the runner.
4. Inspect the resulting file changes.
5. Complete immediately if nothing changed.
6. Reject and discard a hard policy violation.
7. Otherwise set the Run to `awaiting_review` and the Agent to `review`.

Only one active or review-pending Run may exist for an Agent.

### 4. Implement decisions

Add service methods equivalent to:

```ts
approveRun(runId: string, reason?: string): Promise<AgentRun>;
rejectRun(runId: string, reason?: string): Promise<AgentRun>;
```

Approval must promote the staged workspace, commit the proposed Codex thread,
append the assistant response, and return the Agent to `ready`.

Rejection must discard staging, reset the Codex thread to avoid stale model
assumptions, and return the Agent to `ready`.

### 5. Add API routes

Add and validate:

```text
GET  /api/runs/:id/evidence
POST /api/runs/:id/decision
```

Only Runs in `awaiting_review` may receive a decision. Repeated or conflicting
decisions must return a clear conflict response.

## Contracts expected from other workstreams

- Workstream 2: `prepare`, `inspect`, `promote`, and `discard` transaction APIs.
- Workstream 3: creation and validation of an enforceable `RunPolicy`.
- Workstream 4: audit recorder and evidence response shape.

## Acceptance criteria

- Existing Agent CRUD and ordinary no-change Runs still work.
- A changing Run reaches `awaiting_review`.
- Approval commits files, response, and session state.
- Rejection leaves the real workspace unchanged and resets session state.
- Concurrent Runs and decisions are rejected safely.
- Existing version-one data is migrated.
- Relevant tests pass.

## Non-goals

- Do not implement production OAuth.
- Do not claim per-tool Codex interception.
- Do not put filesystem-copy or diff algorithms inside `AgentService`.
- Do not redesign the frontend.

## Handoff

Provide Workstream 4 with the final API response types and provide Workstream 5
with deterministic service entry points that can be tested using a fake runner.
