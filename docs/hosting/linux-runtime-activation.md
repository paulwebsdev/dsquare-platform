# D Hosting Linux runtime activation

This runbook applies only to a dedicated Linux runtime-agent host. Do not enable
customer execution on a shared Render/free web-service instance or on a developer
workstation.

## Required host configuration

- A supported Linux distribution with rootless Podman installed.
- A dedicated, non-root service account for the runtime agent.
- A rootless Podman API socket owned by that service account; never expose the
  socket over a public TCP port.
- A private Podman network named to match `RUNTIME_AGENT_PODMAN_NETWORK`.
- Persistent host directories for the artifact store and runtime workspaces.
  Both the runtime agent and Podman must resolve bind-mount paths to the same
  host directories.
- A pre-pulled, pinned Node.js 22 runtime image. Replace the example mutable tag
  with an approved digest before production use.
- A dedicated PostgreSQL database/role for the runtime registry.
- Firewall rules allowing only the D Hosting API to reach the private agent.
- TLS or a private authenticated tunnel between D Hosting API and the agent.

## Agent environment

Configure the values in `apps/d-hosting-agent/server/.env.example` on the
Linux host. Generate a unique shared secret with `openssl rand -hex 32`.
Keep `RUNTIME_AGENT_EXECUTION_ENABLED=false` during setup.

## Acceptance checks before enabling execution

1. Confirm the agent runs as the dedicated unprivileged service account.
2. Confirm the Podman socket is accessible only to that account.
3. Confirm the configured image is present locally and its digest is approved.
4. Confirm the private network exists and is not externally routable.
5. Confirm artifact/workspace directories persist across agent restarts.
6. Deploy a disposable Node.js test project and verify it runs as UID 10001.
7. Verify read-only root filesystem, dropped capabilities, no-new-privileges,
   memory/CPU/PID limits, and no published host ports.
8. Verify restart, stop, logs, agent restart/reconciliation, and cleanup.
9. Verify a second test website cannot inspect or control the first website.
10. Only after all checks pass, set `RUNTIME_AGENT_EXECUTION_ENABLED=true`,
    restart the agent, and confirm authenticated `/v1/health` reports
    `executionEnabled: true`.

## Current implementation boundary

The runtime agent now has an explicit opt-in switch and verifies that the
Podman API responds over its Unix socket before reporting execution enabled.
This preflight is not a substitute for the acceptance checks above. Node.js
deployment activation in the D Hosting API must also be completed and tested
before customer workloads are accepted.
