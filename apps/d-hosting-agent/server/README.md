# D Hosting Runtime Agent (secure receiver + Podman transport)

The runtime agent is a separate service for a dedicated Linux runtime host. It must not run customer code on the D Hosting API process or the Windows development PC.

## Current safety state

- Authenticates every `/v1` request with the shared HMAC protocol and PostgreSQL-backed single-use nonces.
- Accepts bounded `DSQART01` bundles and verifies the manifest and every file hash.
- Stores uploads privately without extracting or executing them.
- Can materialize validated uploads into a separate workspace with read-only files/directories, rejecting symlinks and enforcing file-count and size limits.
- The Podman API client now supports a private Linux Unix socket transport and bounded container lifecycle requests.
- Runtime artifact intake, Podman provider wiring, registry reconciliation, inspect, bounded/redacted logs, stop/restart and deletion APIs are implemented. D Hosting exposes owner-scoped runtime status, logs and lifecycle routes.
- **Runtime creation remains disabled (HTTP 503).** `startRuntimeAgent` deliberately passes `executionEnabled: false`; do not change this until the dedicated Linux host passes isolation, ingress, lifecycle, restart/recovery and end-to-end security acceptance tests. Merely setting Podman environment variables does not enable customer code.

## Podman host requirements (future activation)

- Dedicated Linux host with rootless Podman and cgroup v2.
- Use the rootless Podman socket (for example, `$XDG_RUNTIME_DIR/podman/podman.sock`) with filesystem permissions restricted to the runtime-agent service account.
- Never expose the Podman API over a public TCP interface. The agent must access it through the Unix socket only.
- Preload a trusted, pinned Node runtime image; do not allow customer requests to select or pull images.
- Configure a dedicated network and an ingress proxy before enabling website execution. Do not publish container ports directly to the public internet.

## Required environment

- `RUNTIME_AGENT_SHARED_SECRET`: same random secret as the D Hosting API; at least 32 UTF-8 bytes.
- `RUNTIME_AGENT_DATABASE_URL`: dedicated runtime-agent PostgreSQL database.
- `RUNTIME_AGENT_STORAGE_ROOT`: absolute private persistent directory outside any web root.
- `RUNTIME_AGENT_HOST`: optional bind IP; defaults to `127.0.0.1`.
- `RUNTIME_AGENT_PORT`: optional TCP port; defaults to `5003`.
- `RUNTIME_AGENT_DB_SSL=true`: certificate-verified PostgreSQL TLS when required.

## Owner-scoped D Hosting runtime API\n\nOnce the private agent is reachable, D Hosting can query `GET /api/v1/projects/:projectId/resources/:resourceId/runtime`, retrieve bounded logs from `GET .../:resourceId/runtime/logs`, and call `POST .../:resourceId/runtime/stop` or `POST .../:resourceId/runtime/restart`. These endpoints require the website owner's D Hosting session. They do not enable runtime creation; the agent still returns HTTP 503 while execution is hard-disabled.\n\n## Local verification

```powershell
npm.cmd test
npm.cmd run typecheck
``

Do not expose this service publicly. For remote connectivity, bind the agent only to a private interface behind HTTPS and firewall rules allowing only the D Hosting API.
