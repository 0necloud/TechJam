# Workstream 5 — Integration, Robustness, Documentation, and Demo

## Objective

Prove that the middleware is real, robust, reproducible, and understandable.
Own cross-workstream acceptance tests, restart and cleanup behavior, final
architecture documentation, and the three-minute demonstration.

## Primary ownership

- New cross-cutting integration test files
- Updates to `README.md`
- Final architecture and threat-model documentation
- Demo fixtures and rehearsal script
- Validation checklist and reproducibility evidence

Avoid editing implementation files owned by other workstreams unless the owner
agrees. File issues or failing tests against the relevant contract instead of
silently changing another workstream's design.

## Required implementation

### 1. Establish the baseline

Before middleware integration:

- Install dependencies.
- Run `npm run check`.
- Complete the starter Agent CRUD and multi-turn acceptance flow.
- Record environment prerequisites, especially WSL2/Linux and the container
  engine used for judging.

Never add credentials or real secrets to fixtures, screenshots, or Git.

### 2. Build deterministic fake runners

Create test runners that operate on the workspace path passed to them:

- Safe writer: adds a source and test file.
- Protected writer: creates `.env`.
- Modifier/deleter: exercises diff categories.
- Slow runner: supports stop, timeout, and revocation tests.
- Failing runner: exercises cleanup and evidence on failure.

Most middleware verification must not depend on live model behavior.

### 3. End-to-end middleware tests

Prove at least:

1. A guarded Run receives staging, not the live workspace.
2. The live workspace is unchanged before review.
3. Approval promotes exactly the proposed changes.
4. Rejection preserves the real workspace.
5. `.env`, traversal, and symbolic-link attempts are denied.
6. Concurrent live changes prevent promotion.
7. Agent A cannot receive Agent B's session path.
8. Expired or revoked policies cannot execute.
9. Stop, delete, timeout, and restart clean up correctly.
10. A rejected Run resets contaminated session state.
11. Evidence is correlated and secrets are redacted.
12. Existing CRUD, Playground, persistence, and multi-turn behavior remain.

### 4. Restart reconciliation

Define and test what happens after restart when a Run was:

- Running in staging
- Waiting for review
- Halfway through promotion
- Cancelled during container cleanup

Pending review may be preserved if its transaction is intact. Incomplete
execution should be cancelled and cleaned. Interrupted promotion must restore
or complete from a documented recoverable state.

### 5. Documentation

Update the repository documentation with:

- The concrete problem and user value
- Architecture B decision and why there is no per-tool interceptor
- Enforcement boundaries and data flow
- Exact local setup and one-command validation
- Demo steps
- Threat model and protected assets
- Known limitations
- Team member contributions

The architecture diagram must distinguish starter-kit components from new
middleware and show where enforcement actually occurs.

### 6. Three-minute demo

Prepare a deterministic sequence:

#### Normal case

1. Select a guarded Agent.
2. Ask it to create a small tested program.
3. Show the staging-only Runtime policy and proposed file changes.
4. Approve the Run.
5. Show successful promotion.

#### Abuse case

1. Ask the Agent to create a dummy `.env` file.
2. Show that the real Codex Run occurred only in staging.
3. Show policy rule `TC002` denying promotion.
4. Show that the live workspace digest is unchanged.
5. Show that the Agent returns to a controllable state.

Use a real model for the final demo, but keep a deterministic fixture ready for
development and troubleshooting. Do not present fake output as a real model
Run.

### 7. Final validation

Before submission:

```text
npm run check
docker compose config
```

Also scan source, logs, evidence, browser storage, screenshots, and Git history
for secrets.

## Acceptance criteria

- All core acceptance and negative cases are automated.
- `npm run check` passes from a clean installation.
- Setup and demo steps work without hidden manual changes.
- The final scenario fits comfortably inside three minutes.
- Architecture claims match the implemented code.
- Limitations are explicit, especially network egress without an Ark gateway.
- No secret appears in repository or demo evidence.

## Non-goals

- Do not inflate test counts with superficial UI snapshots.
- Do not claim optional gateway behavior unless demonstrated.
- Do not rewrite another workstream merely to make a test pass.
- Do not expand the project into production OAuth, ECS, or a general policy
  platform during integration.

## Handoff

Maintain a single integration checklist showing owner, status, failing evidence,
and the exact commit or change that resolves each item. Raise contract failures
to the owning workstream early rather than waiting for final integration.
