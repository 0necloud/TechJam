# Architecture

TrustCommit is a single-node transactional Agent control plane for hackathon use.

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify API"]
    API --> Service["AgentService"]
    Service --> Store["JSON store"]
    Service --> Transaction["Transaction + change policy"]
    Transaction --> Workspace["Staging workspace"]
    Service --> Runner{"AgentRunner"}
    Runner -->|Local POC| Container["Disposable Runtime container"]
    Container --> Ark["Volcengine Ark"]
    Transaction --> Review["Evidence + decision"]
    Review --> Live["Live workspace"]
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs. It never receives the Ark API key.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, staged workspaces, and Runs. One
Agent can have only one active or review-pending Run.

```text
ready -> busy -> review -> ready
  |       |        |
  v       v        v
stopped  error   stopped
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agent, message, and Run metadata
workspaces/AgentID/       Agent-created files
workspaces/.deleted/      Archived deleted workspaces
workspaces/.transactions/ Per-Run staging workspaces
workspaces/.rollback/     Recoverable promotion copies
codex-home/AgentID/       Private Codex configuration and sessions
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every guarded turn.

Guarded execution fails closed instead of falling back to `CodexRunner`. The
container receives staging and one Agent session home only, a read-only root,
bounded `/tmp`, resource limits, dropped capabilities, and
`no-new-privileges`. Approval refuses a changed live digest.

This is Architecture B: Codex acts autonomously inside the Runtime. There is no
pre-tool interceptor. Bridge egress and the Ark credential inside the Runtime
remain residual risks until a separately approved gateway exists.

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| ECS / Compose without a container engine | Application container | Guarded Runs fail closed |
| Local development | Host Node.js | Disposable local container |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The disposable Runtime container is the POC execution boundary. Ordinary
containers are not hardened multi-tenant isolation.
