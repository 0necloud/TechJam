# Workstream 3 — Runtime Isolation and Per-Run Capabilities

## Objective

Turn the container launch configuration into an enforceable, least-privilege
Runtime boundary. A guarded Run must receive only its staging workspace, its own
Codex session directory, and explicitly selected Runtime capabilities.

## Primary ownership

- New `apps/server/src/run-policy.ts`
- `apps/server/src/container-codex-runner.ts`
- Coordinated changes to `apps/server/src/config.ts`
- Coordinated changes to runner request/result types
- Container runner and policy tests

Workstream 1 owns the main shared types file. Agree on interfaces before both
workstreams edit it.

## Architectural fact

The starter uses Architecture B: Codex acts autonomously inside its process or
container. The runner observes JSON events after Codex emits them; it does not
receive interceptable tool calls before execution.

Do not implement or claim a JavaScript guard that approves every Codex tool
call.

## Required implementation

### 1. Define an enforceable Run policy

Use a contract equivalent to:

```ts
interface RunPolicy {
  id: string;
  runId: string;
  agentId: string;
  runtime: "container";
  workspaceAccess: "staging-only";
  sessionAccess: "agent-only";
  networkMode: "current-bridge" | "none" | "ark-gateway";
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  maxDurationMs: number;
}
```

Do not add `allowedTools` unless a mandatory tool broker actually exists.

### 2. Fail closed

A guarded Agent must refuse to execute when the container Runtime is
unavailable. It must not silently fall back to the host-process runner.

Validate before launch that:

- Policy Run and Agent IDs match the request.
- The policy has not expired or been revoked.
- The workspace path is the expected staging path.
- The Codex home belongs to this Agent.

### 3. Private Codex homes

Replace the shared session mount with:

```text
codex-home/<agent-id>/ → /codex-home
```

Create or copy the required Codex configuration into each Agent-specific home.
Agent A must never receive Agent B's session directory.

### 4. Minimal mounts

The guarded container may mount only:

- The Run's staging workspace at `/workspace`
- The selected Agent's Codex home at `/codex-home`

Never mount the live workspace, parent workspace root, host home, repository
root, another Agent's data, or Docker socket.

### 5. Harden the container filesystem

Where compatible with the Runtime:

- Add a read-only root filesystem.
- Add a bounded writable `/tmp` using `tmpfs`.
- Preserve existing CPU, memory, PID, dropped-capability, user, and
  `no-new-privileges` controls.
- Stop the active container if the policy expires or is revoked.

Verify that Codex and the demo task still work after each hardening option.

### 6. Network scope

The current bridge network is a documented residual risk. Do not claim Ark-only
egress unless it is genuinely enforced.

Optional extension, only after core work passes: create an Ark gateway that
holds the real key and accepts a short-lived Run token from an internal Runtime
network. A proxy setting without network-level enforcement is not sufficient.

### 7. Runtime evidence

Return or emit safe facts for Workstream 4:

- Applied policy ID
- Container Runtime and image
- Staging-only mount confirmed
- Private session mount confirmed
- Network mode
- Start, stop, timeout, cancellation, and exit outcome

Do not emit raw environment values or credentials.

## Acceptance criteria

- Guarded Runs cannot use the host-process runner.
- The live workspace path never appears as a guarded Runtime mount.
- Agent A's launch arguments never contain Agent B's Codex home.
- Expired and revoked policies are denied.
- Timeout and revocation stop the container.
- Existing resource limits remain active.
- The Ark key does not appear in argv, audit evidence, or browser data.
- Tests assert the complete launch argument policy.

## Non-goals

- Do not implement imaginary pre-tool interception.
- Do not describe a command wrapper as an unbypassable security boundary.
- Do not promise hostname-only network isolation through `--network bridge`.
- Do not rebuild Codex CLI.

## Handoff

Provide Workstream 1 with the policy creation/validation API, Workstream 4 with
the Runtime evidence schema, and Workstream 5 with launch-argument and
cross-Agent-isolation fixtures.
