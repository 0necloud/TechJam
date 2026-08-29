# Airlock: Capability-Scoped Transactional Agent Runtime

> Implementation status (2026-08-29): the transactional Airlock core and the
> optional Ark-only egress gateway are implemented. Deterministic server tests
> cover policy, transaction, gateway-token, forwarding, denial, and lifecycle
> behavior. A Kali WSL2 Docker 28.5.2 acceptance run confirmed the Linux build,
> all 44 tests, internal-network egress denial, gateway reachability, and live
> rejection of unrelated or unsigned gateway requests.

## 1. One-sentence solution

Every Agent Run receives only a temporary project workspace and a private session, executes inside a restricted container, and must pass deterministic policy checks and human approval before its changes enter the real project.

## 2. Problem

The starter kit already runs Codex in a disposable container, but the container can still:

- Modify the Agent’s real workspace directly.
- Access the shared Codex session directory.
- Connect to the internet.
- Access the Ark credential available inside the Runtime.

A disposable container isolates the process, but changes to mounted directories survive after the container exits.

We need middleware that controls:

1. What the Agent can access while running.
2. Which effects are allowed to become permanent.
3. What evidence is recorded for operators.

## 3. Important architectural decision

The starter uses an autonomous Codex Runtime.

Our JavaScript code does not receive tool calls before Codex executes them. Therefore, we will not claim to intercept every individual file or command tool call.

Enforcement will happen at boundaries Codex cannot bypass:

- Container mounts
- Private session storage
- Container lifetime and resource limits
- Optional network policy
- Workspace promotion

## 4. User experience

A normal Run works as follows:

1. The user sends a task.
2. The platform creates a temporary copy of the Agent workspace.
3. Codex works inside that temporary workspace.
4. The platform calculates the exact file changes.
5. Security policy evaluates the changes.
6. The user sees the proposed changes and policy evidence.
7. The user approves or rejects them.
8. Only approved changes enter the real workspace.

The main product message is:

> Agents can only access their assigned environment, work in quarantine, and require approval before their changes become real.

## 5. Execution flow

```text
User submits task
        ↓
Fastify validates request
        ↓
AgentService creates Run and RunPolicy
        ↓
WorkspaceTransactionManager creates staging workspace
        ↓
ContainerCodexRunner validates RunPolicy
        ↓
Container starts with:
- staging workspace only
- private Agent Codex home
- read-only container filesystem
- time and resource limits
        ↓
Codex performs the task
        ↓
WorkspaceTransactionManager calculates file changes
        ↓
ChangePolicy evaluates changes
        ↓
┌─────────────────┬──────────────────┬─────────────────┐
│ No changes      │ Review required  │ Policy violation│
│ Complete Run    │ Wait for user    │ Reject changes  │
└─────────────────┴──────────────────┴─────────────────┘
                           ↓
                    Approve or reject
                           ↓
              Promote or discard staging
```

## 6. Per-Run policy

Each Run receives a policy snapshot created by `AgentService`.

```ts
interface RunPolicy {
  id: string;
  runId: string;
  agentId: string;

  runtime: "container";
  workspaceAccess: "staging-only";
  sessionAccess: "agent-only";

  networkMode: "current-bridge" | "ark-gateway" | "none";

  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;

  maxDurationMs: number;
}
```

The policy contains only capabilities that the platform can genuinely enforce.

We will not include an `allowedTools` list unless a real mandatory tool broker is implemented.

### Enforcement rules

Before launching a container, the runner must verify:

- The policy belongs to the current Run and Agent.
- The policy has not expired.
- The policy has not been revoked.
- The Runtime provider is `container`.
- The workspace path is the Run’s staging workspace.
- The Codex home belongs only to the selected Agent.

If a policy expires or is revoked during execution, `AgentService` stops the container.

## 7. Filesystem isolation

Use this layout:

```text
workspaces/
├── <agent-id>/                       Real workspace
├── .transactions/
│   └── <run-id>/
│       └── workspace/                Temporary workspace
└── .rollback/
    └── <run-id>/                     Promotion recovery copy

codex-home/
├── <agent-a-id>/                     Agent A sessions only
└── <agent-b-id>/                     Agent B sessions only
```

The container receives only these writable mounts:

```text
.transactions/<run-id>/workspace → /workspace
codex-home/<agent-id>             → /codex-home
```

The following must never be mounted:

- The real workspace
- The parent `workspaces` directory
- Another Agent’s Codex home
- The host home directory
- The repository root
- The Docker socket

The container root filesystem should be read-only. A bounded temporary filesystem may be mounted at `/tmp`.

## 8. Workspace transactions

Add a `WorkspaceTransactionManager` with four operations:

```ts
prepare(runId, liveWorkspace)
inspect(transaction)
promote(transaction)
discard(transaction)
```

### Prepare

- Calculate a digest of the real workspace.
- Create the staging directory.
- Copy project files into staging.
- Do not follow symbolic links.
- Exclude generated directories such as `node_modules`, `dist`, `.git`, and `.codex`.

### Inspect

Compare the staging workspace with the real workspace.

Produce:

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

Patches must be size-limited and redacted before storage.

### Promote

Before promotion:

1. Recalculate the real workspace digest.
2. Compare it with the digest recorded at Run start.
3. Refuse promotion if the real workspace changed concurrently.

Promotion uses a recoverable rename sequence:

```text
real workspace → rollback directory
staging workspace → real workspace
```

If promotion fails, restore the rollback directory.

### Discard

Delete only the staging directory associated with the Run.

The absolute target must be resolved and verified as a child of `.transactions` before recursive deletion.

## 9. Change policy

Policy is deterministic code, not an AI prompt.

```ts
evaluateChanges(changes: FileChange[]): PolicyDecision
```

### Automatic rejection

Reject changes involving:

- `**/.env` or `**/.env.*`
- `**/.codex/**`
- `**/.git/**`
- Platform-managed `**/AGENTS.md`
- Paths containing traversal outside the workspace
- Symbolic links
- Credential-like content
- Files exceeding configured limits

Protected names are matched on every path segment rather than only at the
workspace root. A nested `config/.env` leaks the same secrets as a root one, a
nested `vendor/.git/hooks/pre-commit` still executes on the operator's next
commit, and Codex reads `AGENTS.md` from every directory it walks, so a nested
copy persists instructions into later turns. Matching is case-insensitive so a
denial does not depend on host filesystem case-folding rules.

### Human review

Require approval for:

- Normal source-code changes
- Tests and documentation
- File deletion or rename
- Package manifests and lockfiles
- CI or deployment configuration
- Large or numerous changes

Higher-risk changes should display stronger warnings, but protected-path violations cannot be manually overridden in the POC.

## 10. Run lifecycle

Add these Run states:

```text
queued
running
awaiting_review
completed
rejected
failed
cancelled
```

Add this Agent state:

```text
review
```

State flow:

```text
queued → running → awaiting_review → completed
                    │
                    └─────────────→ rejected

queued/running → failed
queued/running → cancelled
```

Only one active or review-pending Run is allowed per Agent.

## 11. Session handling

The thread ID returned by Codex is initially stored as `proposedThreadId`.

On approval:

- Promote the files.
- Save `proposedThreadId` as the Agent’s active `codexThreadId`.
- Add the assistant response to the canonical conversation.

On rejection:

- Discard the files.
- Do not commit the proposed thread.
- Reset the Agent’s `codexThreadId` to `null`.

Resetting is necessary because the rejected Codex conversation may assume that discarded files still exist.

## 12. Audit evidence

Record structured events correlated by Run ID:

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

Each event contains:

- Event ID
- Run ID
- Agent ID
- Timestamp
- Event type
- Safe summary
- Policy rule IDs where relevant

Secrets, raw environment values, and unlimited command output must not be stored.

Audit logging is evidence of enforcement; it is not itself the enforcement mechanism.

## 13. API changes

Add:

```http
GET /api/runs/:id/evidence
```

Returns the policy summary, audit timeline, proposed file changes, and decision state.

Add:

```http
POST /api/runs/:id/decision
```

Request:

```json
{
  "decision": "approve",
  "reason": "Reviewed source and test changes"
}
```

Only Runs in `awaiting_review` may receive a decision.

Approval and rejection must be idempotent or return a clear conflict response.

## 14. UI changes

Add one Run Evidence panel to the existing Playground.

It should show:

- Applied execution policy
- Run status
- Added, modified, and deleted files
- Risk level and triggered policy rules
- Confirmation that the real workspace is unchanged
- Approve and Reject buttons
- Final promotion or rejection outcome

Do not rebuild the application or create a general workflow editor.

## 15. Codebase changes

### Modify

```text
apps/server/src/types.ts
apps/server/src/store.ts
apps/server/src/agent-service.ts
apps/server/src/app.ts
apps/server/src/workspace.ts
apps/server/src/container-codex-runner.ts

apps/web/src/types.ts
apps/web/src/api.ts
apps/web/src/App.tsx
apps/web/src/styles.css
```

### Add

```text
apps/server/src/run-policy.ts
apps/server/src/workspace-transaction.ts
apps/server/src/change-policy.ts
apps/server/src/audit-recorder.ts
```

## 16. Required automated tests

Tests must prove:

1. Codex receives the staging path, not the real workspace.
2. The real workspace remains unchanged before approval.
3. Approval promotes the exact staged changes.
4. Rejection preserves the real workspace.
5. Protected files are automatically rejected.
6. Path traversal and symbolic links are rejected.
7. Concurrent real-workspace changes prevent promotion.
8. Agent A cannot receive Agent B’s Codex home.
9. Expired or revoked policies cannot launch a Run.
10. Stop, delete, and restart correctly clean up transactions.
11. Rejected Runs do not preserve contaminated session state.
12. Audit evidence is redacted.

Most tests should use a fake runner that writes files into the provided workspace. A real model is needed only for final end-to-end validation.

## 17. Three-minute demonstration

### Normal case

1. Select an Agent.
2. Ask it to create a small tested program.
3. Show that execution used a temporary workspace.
4. Display the proposed source and test files.
5. Approve the changes.
6. Show successful promotion into the real workspace.

### Abuse case

1. Ask the Agent to create or modify `.env`.
2. Show the real Agent execution.
3. Show the deterministic policy violation.
4. Show automatic rejection.
5. Show that the real workspace digest did not change.
6. Show that the Agent returns to a usable state.

## 18. Explicit non-goals

The POC will not claim to provide:

- Pre-execution interception of every Codex tool call
- Production OAuth or enterprise identity
- A general-purpose policy engine
- Complete protection against container escape
- Arbitrary secure access to host-installed programs
- Production-grade network isolation or a general package/network broker
- Production multi-process or distributed storage
- Mandatory ECS deployment

## 19. Implemented network-security extension

Supported POC and host-deployment paths now add an Ark gateway:

```text
Codex container → short-lived Run token → Ark gateway → real Ark credential → Ark model
```

The Runtime container joins an internal network and can reach only the gateway. The gateway holds the real Ark key and rejects unrelated destinations.

The gateway accepts only `POST /api/v3/responses...`, verifies an HMAC-signed
token containing the policy, Run, Agent, and expiry identifiers, then replaces
that token with the real Ark key when calling the fixed upstream. Startup
proves that a Runtime peer cannot reach a public destination directly and can
reach the gateway health endpoint.

`current-bridge` remains an explicit compatibility mode for npm, GitHub, and
other public tools. It restores unrestricted outbound access and exposes the
Ark key to the Runtime, so evidence must identify that weaker mode.

## 20. Definition of done

The solution is complete when:

- Existing Agent CRUD and Playground behavior still works.
- A real Codex Run executes inside a staged workspace.
- The UI displays genuine file-change and policy evidence.
- Safe changes can be approved and promoted.
- A protected change is rejected while the real workspace remains unchanged.
- The Agent remains controllable afterward.
- Core middleware behavior has automated tests.
- `npm run check` passes.
- No secrets appear in source, logs, evidence, or browser output.

