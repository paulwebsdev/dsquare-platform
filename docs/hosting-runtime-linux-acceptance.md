# D Hosting Linux Runtime Acceptance

## What the automated Linux check proves

The GitHub Actions workflow `.github/workflows/d-hosting-runtime-linux.yml` runs the D Hosting API and runtime-agent typecheck/test suites on Linux, then starts a restricted Node.js 22 container with rootless Podman. The latest recorded run for this branch passed both jobs.

This proves the tested runtime foundation works on a temporary Linux CI runner. It does **not** prove that a persistent production host, customer deployment flow, or public website ingress is ready.

## Current implementation boundary

The following pieces exist:

- Authenticated private runtime-agent API and artifact transfer.
- Podman container create/start/stop/restart/inspect/log/remove provider.
- Runtime workspace integrity checks, safe materialization, reconciliation and orphan cleanup.
- Resource limits, non-root container user, read-only root filesystem, dropped capabilities, no-new-privileges, and no published host ports.
- D Hosting runtime status, lifecycle and bounded-log API routes.
- Linux CI checks for API/agent tests and a restricted Node.js 22 Podman container.

The following pieces are **not yet connected or accepted**, so Node.js deployment creation must remain disabled:

1. The D Hosting deployment route still creates static snapshots only and returns HTTP 409 for Node.js projects. The existing remote-runtime preparation/transfer client is not wired into deployment creation.
2. The current uploaded artifact is mounted read-only and does not include a verified dependency installation/build stage. Do not run customer `npm install` on the Hosting API host. Dependency installation must happen inside a separately constrained build sandbox, with lockfile handling and resource/time limits.
3. The Podman provider intentionally publishes no host ports. A private ingress/reverse-proxy path that routes an assigned hostname to the correct container and port 3000 still needs implementation and security tests.
4. The runtime agent startup explicitly passes `executionEnabled: false`. Do not change this to true based only on CI success.
5. Production persistence, host restart recovery, per-customer isolation, and real end-to-end website requests must be tested on the actual dedicated Linux host.

## Production activation acceptance checklist

Do not enable customer code execution until every item below is verified on the actual dedicated Linux host:

- [ ] Dedicated Linux host with cgroup v2 and rootless Podman.
- [ ] Runtime agent runs as a dedicated unprivileged OS account.
- [ ] Podman Unix socket is accessible only to that account; never expose Podman's API on public TCP.
- [ ] A pinned, trusted Node.js 22 image is preloaded and image pulls are disabled during customer deployment.
- [ ] Runtime workspace and artifact roots are persistent, private, on the same host filesystem, and not web-served.
- [ ] Dependency installation/build runs in a separate constrained sandbox, not on the Hosting API host.
- [ ] Private ingress proxy routes to the correct container without publishing customer container ports publicly.
- [ ] Containers cannot reach host services, the Podman socket, cloud metadata endpoints, or other customers' containers.
- [ ] Memory, CPU, PID, file, storage, build-time and request limits are enforced and tested.
- [ ] Runtime-agent restart, host restart, crash recovery, orphan cleanup, stop/restart, logs and deployment replacement are tested.
- [ ] A real sample Node.js website starts and serves HTTP through private ingress.
- [ ] A second test website proves container, network, filesystem, environment and database isolation.
- [ ] Secrets and D Database credentials are absent from browser responses and logs.
- [ ] Deployment failure cleanup and rollback are verified.

## Linux host preparation (run only on the dedicated runtime host)

Install rootless Podman using the Linux distribution's supported package manager. Enable cgroup v2 and configure the dedicated service account's user socket. Confirm the socket path with:

```sh
printf '%s\\n' "$XDG_RUNTIME_DIR"
podman info --format '{{.Host.CgroupsVersion}}'
podman info --format '{{.Host.Security.Rootless}}'
systemctl --user status podman.socket
```

Set the runtime-agent environment from `apps/d-hosting-agent/server/.env.example` using private server-side secrets. Do not commit real credentials. Keep the agent bound to a private interface and firewall it so only the D Hosting API can reach it.

## Current activation state

The HTTP runtime agent intentionally starts with `executionEnabled: false`. Keep this hard-disabled until the unconnected deployment flow, dependency/build sandbox, private ingress and production-host acceptance list above are complete. GitHub-hosted runners are temporary CI machines and must never be used as customer hosting infrastructure.
