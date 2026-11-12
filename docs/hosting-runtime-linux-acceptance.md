# D Hosting Linux Runtime Acceptance

## What this check proves

The GitHub Actions workflow `.github/workflows/d-hosting-runtime-linux.yml` runs the D Hosting API and runtime-agent test suites on Linux, then starts a restricted Node.js 22 container with Podman. This is a repeatable Linux CI check, not a production runtime host.

## Production activation remains blocked until all checks pass on the actual dedicated Linux host

Do not set `executionEnabled: true` merely because CI passes or the runtime agent can reach Podman. Before customer code execution is enabled, verify:

- A dedicated Linux host with cgroup v2 and rootless Podman.
- The runtime agent runs as a dedicated unprivileged OS account.
- The Podman Unix socket is accessible only to that account; never expose Podman's API on public TCP.
- A pinned, trusted Node.js 22 image is preloaded and image pulls are disabled during customer deployment.
- The runtime workspace and artifact roots are persistent, private, on the same host filesystem, and not web-served.
- The private website ingress proxy can reach containers without publishing customer container ports publicly.
- Containers cannot reach host services, the Podman socket, cloud metadata endpoints, or other customers' containers.
- Memory, CPU, PID, file, storage and request limits are enforced and tested.
- Runtime-agent restart, host restart, crash recovery, orphan cleanup, stop/restart, logs and deployment replacement are tested.
- A real sample Node.js website starts, serves HTTP through the private ingress path, and is isolated from a second test website.
- Secrets and D Database credentials are absent from browser responses and logs.

## Linux host preparation (run only on the dedicated runtime host)

Install rootless Podman using the Linux distribution's supported package manager. Enable cgroup v2 and configure the dedicated service account's user socket. Confirm the socket path with:

```sh
printf '%s\n' "$XDG_RUNTIME_DIR"
podman info --format '{{.Host.CgroupsVersion}}'
podman info --format '{{.Host.Security.Rootless}}'
systemctl --user status podman.socket
```

Set the runtime-agent environment from `apps/d-hosting-agent/server/.env.example` using private server-side secrets. Do not commit real credentials. Keep the agent bound to a private interface and firewall it so only the D Hosting API can reach it.

## Current activation state

The HTTP runtime agent intentionally starts with `executionEnabled: false`. Keep this hard-disabled until the production-host acceptance list above is completed. GitHub-hosted runners are temporary CI machines and must never be used as customer hosting infrastructure.
