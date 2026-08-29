# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Shared demo token; no user identity, authorization, RBAC, or tenant isolation
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access when explicitly using `current-bridge` mode
- Prompt-triggered command and file execution
- Ark key available to the gateway container and deployment operator; in
  `current-bridge` mode it is also available to the active Runtime
- Ark key stored in Terraform POC state
- Ark gateway is a POC HTTP boundary, not a hardened production egress service

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key and a unique `APP_AUTH_TOKEN`.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Prefer the default `ark-gateway` mode. Use `current-bridge` only for Runs that
  genuinely need npm, GitHub, or other public services.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
