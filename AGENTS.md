# TrustCommit repository instructions

## Required context

Before changing application code, read these files completely:

1. `README.md`
2. `docs/ARCHITECTURE.md`
3. `docs/HACKATHON_EXTENSION_GUIDE.md`
4. `docs/TRUSTCOMMIT_IMPLEMENTATION.md`
5. Every file under `docs/workstreams/`

Treat `docs/TRUSTCOMMIT_IMPLEMENTATION.md` as the source of truth when a
workstream document is less specific.

## Current state

- TrustCommit application code has not been implemented yet.
- The added files under `docs/workstreams/` are planning documents only.
- The last Windows `npm run check` attempt stopped before compilation because
  dependencies were not installed.
- Full Runtime development and acceptance should use WSL2/Linux. Kali WSL2 is
  acceptable when Node.js 22+, npm 10+, and Docker are working.

## Working agreement

- Default to one sequential implementation owner. Do not delegate or split work
  across subagents unless the user explicitly requests it.
- Inspect the existing implementation and establish the baseline before editing.
- Preserve Agent CRUD, lifecycle actions, Playground chat, persistence,
  asynchronous Runs, and multi-turn Codex sessions.
- Implement the core in this order:
  1. Shared types and database migration.
  2. Workspace transactions and deterministic change policy.
  3. Per-Agent Codex homes and guarded container policy.
  4. AgentService lifecycle and approval/rejection APIs.
  5. Audit evidence and React review UI.
  6. Reconciliation, negative tests, documentation, and demo validation.
- Use fake runners for deterministic middleware tests. Use the live Ark model
  only for final end-to-end validation.
- Run focused tests after each phase and `npm run check` before handoff.
- Keep changes focused. Preserve unrelated user work.

## Security and scope rules

- The starter uses Architecture B: Codex acts autonomously in its Runtime.
- Do not implement or claim pre-execution interception of every Codex tool call.
- Enforce access using real container mounts, private session storage, Runtime
  limits, deterministic file policy, and controlled workspace promotion.
- Do not implement the optional Ark gateway unless the core definition of done
  passes and the user explicitly approves the extension.
- Until a gateway exists, document bridge networking and Runtime access to the
  Ark credential as residual risks.
- Never commit, log, display, or place real credentials in fixtures.
- Do not silently weaken a security control to make a test pass. Record the
  limitation or fail closed.

## Completion requirements

- A changing Run executes against staging, not the live workspace.
- Safe changes wait for review and can be promoted.
- A protected `.env` change is rejected while the live workspace stays
  unchanged.
- Approval, rejection, conflict, cancellation, deletion, restart, and redaction
  behavior have automated evidence.
- Existing baseline behavior remains functional.
- `npm run check` passes.

