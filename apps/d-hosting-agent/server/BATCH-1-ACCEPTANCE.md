# D Hosting Batch 1 — final acceptance gate

Status: **CI checks pass; production Linux acceptance is not yet complete.**

This document is the Unit 7 acceptance record and the gate for enabling customer backend execution. A green GitHub Actions run is necessary but is not proof of a live production deployment.

## 1. Automated checks already verified

On commit `954b3111a15e0046e4036b8a7e41ae032571eb19`, GitHub Actions run `43360487498` completed successfully:

- Hosting API typecheck and tests.
- Runtime-agent typecheck and tests.
- Rootless Podman Linux smoke test: rootless host/cgroup support and a restricted Node.js 22 container.

These checks do **not** verify a full customer build, a real Caddy deployment, public DNS/ACME, or a live runtime cutover.

## 2. Required Linux host checks

Run on the dedicated Linux runtime host as the dedicated unprivileged service account. Do not run customer code on the Hosting API host or a developer workstation.

```sh
# Rootless Podman and cgroup v2
podman info --format '{{.Host.Security.Rootless}}'
podman info --format '{{.Host.CgroupsVersion}}'

# Required private network and Caddy container
podman network inspect dsquare-private
podman inspect dsquare-caddy

# The Podman API socket must be a Unix socket, not a public TCP endpoint.
test -S "${XDG_RUNTIME_DIR}/podman/podman.sock"

# Caddy admin API must answer locally.
curl --fail --silent --show-error http://127.0.0.1:2019/config/ >/dev/null

# Confirm host listeners. Public 80/443 are expected; 2019 must be loopback-only.
ss -lntup
```

Record the output in the deployment operations log, excluding secrets, tokens, environment values, and private customer data. Confirm that port 2019 is not reachable from a separate external host.

## 3. Public ingress acceptance

Before enabling any test hostname:

- Verify domain ownership and DNS A/AAAA records point to the ingress host.
- Verify Caddy data/config volumes persist after a Caddy restart and container replacement.
- Verify the hostname receives a valid ACME certificate.
- Verify HTTP redirects to HTTPS with status 308.
- Verify an unknown or unverified hostname cannot reach a runtime.
- Verify request bodies above 10 MiB return 413, including chunked requests without Content-Length.
- Verify normal uploads work and stalled uploads are terminated.
- Verify SSE/chunked streaming and WebSocket bidirectional traffic work, including a WebSocket that spans a Caddy config reload.
- Stop a test upstream and verify the public response is a generic, non-cacheable 503 with no private upstream address or stack trace.
- Verify application-generated 404 and 500 responses are preserved.

Use a disposable test domain and test application. Do not use a customer's production domain for fault injection.

## 4. Builder, runtime and deployment acceptance

On the dedicated Linux host, using disposable test projects and test data:

- Confirm the approved builder image is pinned and the builder has no network access.
- Confirm the npm cache is provisioned only by the trusted host process and outbound firewall policy restricts it to approved registry/CDN endpoints.
- Confirm lifecycle scripts remain disabled for the initial Node builder profile.
- Build a valid Node project and reject invalid manifests, unsupported install scripts, oversized archives, path traversal, symlinks, and corrupt artifact hashes.
- Confirm build deadlines, output limits, CPU/memory/PID limits, read-only mounts, dropped capabilities, and cleanup after both success and failure.
- Confirm runtime containers use only the pinned trusted image, rootless Podman, the private network, non-root UID, read-only root filesystem, no-new-privileges, dropped capabilities, bounded resources, and no published host ports.
- Confirm readiness is required before a deployment can become active.
- Confirm a failed build or unhealthy runtime leaves the previous deployment active.
- Confirm rollback changes ingress to a healthy prior deployment and restores the previous active pointer if ingress synchronization fails.
- Confirm concurrent deploys cannot replace a newer active deployment.
- Restart the agent and Podman; verify reconciliation correctly handles running, stopped, interrupted, and orphaned containers without deleting active deployments.
- Confirm logs are bounded and redacted and owner-scoped Hosting routes cannot access another user's runtime.

## 5. Execution safety gate

Customer runtime creation is intentionally disabled in the runtime-agent startup configuration (`executionEnabled: false`). Keep it disabled until every check in Sections 2–4 has been run on the actual target Linux host and its result has been reviewed.

Do not treat a successful unit test, a Podman smoke test, a completed checklist document, or a successful configuration upload as permission to enable execution.

## 6. Acceptance evidence

Complete this record after the live checks have been run:

| Evidence | Result | Evidence reference / date |
| --- | --- | --- |
| Dedicated Linux host and rootless cgroup v2 | Pending | |
| Podman private network and Unix socket | Pending | |
| Caddy loopback-only admin and persistent volumes | Pending | |
| DNS, ACME certificate and HTTP-to-HTTPS redirect | Pending | |
| Upload limits, streaming, WebSocket and reload behavior | Pending | |
| Gateway failure isolation and application status preservation | Pending | |
| Builder isolation, cache egress and artifact validation | Pending | |
| Runtime resource/security isolation and readiness | Pending | |
| Deploy, failed deploy, rollback and concurrency | Pending | |
| Agent restart and orphan reconciliation | Pending | |
| Owner isolation and redacted bounded logs | Pending | |

**Current Unit 7 outcome:** automated repository checks pass. Live Linux acceptance remains pending; customer execution remains disabled.
