# Codex implementation handover prompt

Use the prompt below when opening the WSL repository in a fresh Codex task.

---

Implement the complete TrustCommit middleware described in
`docs/TRUSTCOMMIT_IMPLEMENTATION.md`.

Before editing:

1. Read `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`,
   `docs/HACKATHON_EXTENSION_GUIDE.md`, the TrustCommit specification, and all
   files under `docs/workstreams/`.
2. Inspect the existing server, runner, workspace, persistence, tests, and React
   Playground code.
3. Install dependencies and establish the baseline with `npm run check`.
4. Report baseline failures separately from implementation failures.

Implementation rules:

- Work sequentially as the sole implementation owner.
- Preserve Agent CRUD, lifecycle actions, Playground chat, persistence, and
  multi-turn Codex execution.
- Implement Architecture B using real container mounts and workspace-promotion
  boundaries.
- Do not implement or claim per-tool Codex interception.
- Do not implement the optional Ark gateway unless all core requirements are
  complete and I explicitly approve it.
- Treat current bridge networking and raw Ark credential exposure as documented
  residual risks.
- Use deterministic fake runners for automated middleware tests.
- Never commit or display credentials.
- Keep a working plan and validate after each major phase.

Implementation order:

1. Shared types and database migration.
2. Workspace transaction manager and deterministic change policy.
3. Per-Agent Codex homes and guarded container policy.
4. AgentService lifecycle and approval/rejection APIs.
5. Audit evidence and React review panel.
6. Restart reconciliation, negative tests, documentation, and demo preparation.

Definition of done:

- A real Run executes against staging rather than the live workspace.
- Safe changes wait for review and can be promoted.
- A protected `.env` change is rejected while the live workspace remains
  unchanged.
- Approval, rejection, cancellation, deletion, conflict, and restart behavior
  are tested.
- Existing baseline behavior remains functional.
- `npm run check` passes.
- Architecture and security claims match the implemented code.

Proceed autonomously through the core implementation. Ask for input only if
credentials are required for final real-model validation or a genuinely
scope-changing decision cannot be resolved from the specification.

---

## Expected WSL setup

The repository should preferably live under `~/code/CodeJam-main` in WSL2,
not under `/mnt/e`, so Linux filesystem, permissions, and rename behavior match
the target Runtime more closely.

Before starting:

```bash
node --version
npm --version
docker version
npm install
npm run check
```

Required versions:

- Node.js 22 or newer
- npm 10 or newer
- WSL2
- A working Docker-compatible container engine

The Ark API key and endpoint are required only for final live-model validation.
Do not add them to source control.
