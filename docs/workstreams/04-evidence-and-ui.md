# Workstream 4 — Audit Evidence and Review UI

## Objective

Make the middleware understandable and controllable. Record safe, structured
evidence for each Run and add the smallest UI necessary to review proposed
changes, understand a denial, and approve or reject a Run.

## Primary ownership

- New `apps/server/src/audit-recorder.ts`
- `apps/web/src/types.ts`
- `apps/web/src/api.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/styles.css`
- Focused audit and frontend behavior tests where practical

Workstream 1 owns server routes and lifecycle transitions. Agree on the
evidence API response before implementing the final UI wiring.

## Required implementation

### 1. Audit event contract

Define structured events correlated by Run ID:

```text
run.created
policy.created
workspace.staged
runtime.started
runtime.completed
workspace.inspected
policy.review_required
policy.denied
human.approved
human.rejected
workspace.promoted
workspace.discarded
run.completed
run.failed
```

Each event should contain:

- Event ID
- Run ID
- Agent ID
- Timestamp
- Type
- Safe human-readable summary
- Relevant policy rule IDs

Audit logging is evidence, not the enforcement mechanism.

### 2. Redaction and bounds

Before persistence or display:

- Redact API keys, bearer tokens, passwords, private keys, and common secret
  assignments.
- Bound summary, patch, event-count, and total evidence sizes.
- Do not store raw environment variables.
- Treat commands, paths, and model-produced text as untrusted display content.

The UI must render evidence as text, never executable HTML.

### 3. Evidence API client

Consume the Workstream 1 routes:

```text
GET  /api/runs/:id/evidence
POST /api/runs/:id/decision
```

Add typed client methods for loading evidence and submitting approval or
rejection.

### 4. Lifecycle support in React

Teach the UI about:

- Agent status `review`
- Run status `awaiting_review`
- Run status `rejected`

Polling should stop when execution reaches `awaiting_review`, then load the
evidence. The message composer must remain disabled while a decision is
pending.

### 5. Run Evidence panel

Add one compact panel to the existing Playground showing:

- Applied Runtime policy
- Timeline of major events
- Added, modified, and deleted files
- Risk level and rule explanations
- "Live workspace unchanged" while review is pending
- Approve and Reject actions
- Final promoted, rejected, failed, or cancelled outcome

Approval should require a clear action. Rejection may accept an optional reason.
Avoid a large redesign or separate observability product.

### 6. Human-readable policy messages

Translate rule IDs into explanations such as:

```text
TC002 — Environment files may contain secrets and cannot be promoted.
TC004 — Symbolic links are blocked because they can escape the workspace.
```

Always display both the concise explanation and stable rule ID so the demo and
tests refer to the same evidence.

## Acceptance criteria

- A pending Run visibly shows that changes are not yet live.
- Added, modified, and deleted files are distinguishable.
- Approve and Reject invoke real backend decisions.
- A denial shows the exact rule and preserved-workspace result.
- The UI remains usable after approval, rejection, failure, and cancellation.
- Secrets in evidence fixtures are redacted before storage and display.
- Existing CRUD, settings, lifecycle controls, and chat remain usable.

## Non-goals

- Do not expose chain-of-thought or private model reasoning.
- Do not build live WebSockets unless polling proves insufficient.
- Do not add a general log query language.
- Do not treat an attractive timeline as proof of enforcement.

## Handoff

Give Workstream 5 stable screenshots/demo states and a list of expected event
types for success, denial, rejection, failure, cancellation, and promotion.
