# D Hosting Runtime Agent (secure receiver + Podman transport)

See [Caddy private ingress provisioning](./CADDY-INGRESS.md) for the Linux host network layout, persistent certificate storage, loopback-only admin publication, and pre-activation acceptance checklist.

The runtime agent is a separate service for a dedicated Linux runtime host. It must not run customer code on the D Hosting API process or the Windows development PC.

## Current safety state

- Authenticates every `/v1` request with the shared HMAC protocol and PostgreSQL-backed single-use nonces.
- Accepts bounded `DSQART01` bundles and verifies the manifest and every file hash.
- Stores uploads privately without extracting or executing them.
- Can materialize validated uploads into a separate workspace with read-only files/directories, rejecting symlinks and enforcing file-count and size limits.
- Each website resource receives a private persistent directory mounted read/write at `/var/lib/dsquare` in its runtime. The directory is keyed by resource ID, reused across deployment versions, and retained when a deployment is removed; deployment artifacts remain immutable and read-only.
- Persistent storage is a host bind mount using Podman's `:U,Z` options. The dedicated Linux host must validate rootless UID mapping and SELinux relabel behavior. Encrypted persistent-storage backup creation and authenticated restore are implemented in `persistent-storage-backups.ts`. Backups use a versioned format, gzip compression, AES-256-GCM authenticated encryption, per-file SHA-256 verification, bounded file/size limits, symlink rejection, and an atomic directory swap on restore. Usage measurement, deletion tombstoning, and age-based backup pruning are also implemented. The agent now exposes HMAC-authenticated backup/list/restore/delete, usage, and tombstone routes under `/v1/storage/:resourceId`. Restore and tombstone require explicit confirmation. Backup metadata and lifecycle audit events are stored in the runtime-agent database. The trusted D Hosting API must authenticate the website owner, authorize the resource, and scope every request before forwarding it to this agent; the agent HMAC authenticates the service caller, not an end customer.

A single-flight scheduled backup pass runs at the configured interval and prunes expired local snapshots only after a new snapshot succeeds for that resource. Configure a dedicated base64 32-byte `RUNTIME_AGENT_BACKUP_KEY` and private `RUNTIME_AGENT_BACKUP_ROOT`; this key is distinct from the HMAC and database credentials. The local backup directory is not an off-host disaster-recovery copy and must be replicated to independently protected object storage or another host.

An XFS project-quota adapter and authenticated quota-provisioning route are included. The route reserves a deterministic project-ID candidate under a database UNIQUE constraint, creates the private website directory, verifies that its backing filesystem is XFS mounted with `prjquota` or `pquota`, applies project inheritance and a hard block limit, and records successful activation. Runtime creation checks this activation record and fails closed if the quota was not applied. Hash collisions fail closed and require operator allocation. Directory usage measurement is accounting only, never enforcement. The adapter and command behavior still require live validation on the dedicated Linux host before execution can be enabled.
- The Podman API client now supports a private Linux Unix socket transport and bounded container lifecycle requests.
- Runtime artifact intake, Podman provider wiring, registry reconciliation, inspect, bounded/redacted logs, stop/restart and deletion APIs are implemented. D Hosting exposes owner-scoped runtime status, logs and lifecycle routes.
- **Runtime creation remains disabled (HTTP 503).** `startRuntimeAgent` deliberately passes `executionEnabled: false`; do not change this until the dedicated Linux host passes isolation, ingress, lifecycle, restart/recovery and end-to-end security acceptance tests. Merely setting Podman environment variables does not enable customer runtime processes.
- The isolated Node builder creates a rootless, networkless Podman container with a read-only source mount, writable disposable workspace, read-only verified npm cache, CPU/memory/PID limits, read-only root filesystem, dropped capabilities and no-new-privileges. Build output is bounded, integrity checked and packaged as a new immutable runtime artifact.
- The authenticated `/v1/builds` API remains disabled unless `RUNTIME_AGENT_BUILDER_ENABLED=true` and every builder setting is present. Cache provisioning runs npm 10 on the trusted agent host, so a real outbound firewall policy restricting it to approved npm registry/CDN endpoints is mandatory before acknowledging `RUNTIME_AGENT_NPM_REGISTRY_EGRESS_RESTRICTED=true`.
- The Hosting API now has a Node deployment pipeline that transfers source, requests the isolated build, starts the built artifact, waits for the runtime readiness probe, and only then records/activates the deployment. It cannot run until the builder and runtime agent are configured.

## Persistent storage backup and lifecycle primitives\n\n`src/persistent-storage-backups.ts` provides encrypted snapshots and safe restore operations. Generate a dedicated 32-byte backup key outside the application, store it in a secret manager, and keep it separate from database/runtime credentials. Do not commit backup keys or backup files. Backups should be written to a separate protected filesystem or object-storage destination, with an independent off-host copy. `prunePersistentBackups` only removes expired backup files for the requested resource; invoke it only after the retention policy and backup health have been checked. `tombstonePersistentStorage` moves a deleted website directory to a private tombstone instead of immediately erasing customer data.\n\nThe current code does not yet schedule backup jobs or expose owner/admin backup APIs. Those integrations, hard filesystem quota enforcement, quota-exhaustion tests, and Linux host acceptance remain required before enabling customer execution.\n\n## Public website request handling

The generated Caddy JSON config is the public HTTPS edge for verified website domains. Use Caddy v2.11.8 or newer for the request-body and HTTP idle-timeout controls in this configuration. Caddy's TLS automation manages certificates for configured public hostnames, and the generated HTTP routes explicitly issue a 308 redirect to HTTPS; the Linux host must make TCP ports 80 and 443 reachable and retain Caddy's data/config volumes.

Each website route applies a 10 MiB request-body ceiling before proxying. The HTTP server also has bounded header, upload, idle-read and idle-write settings to reduce slow-client resource exhaustion. The reverse proxy uses low-latency flushing for streaming responses, supports WebSocket upgrades through Caddy's native reverse proxy, and allows streams up to 24 hours. A five-minute stream-close delay reduces abrupt WebSocket disconnects during config reloads. Upstream connection and response-header timeouts remain bounded.

Upstream gateway failures (502/503/504) are replaced with a generic 503 response and `Cache-Control: no-store`; internal upstream addresses and error details are not exposed. Application-generated responses such as an intentional 404 or 500 are passed through unchanged.

These controls are configuration-level protections. They still require Linux-host acceptance with real HTTPS certificates, oversized and chunked uploads, SSE/streaming responses, WebSocket upgrades, slow-client behavior, unavailable runtimes and Caddy reloads before customer execution can be enabled.

## Podman host requirements (future activation)

- Dedicated Linux host with rootless Podman and cgroup v2.
- Use the rootless Podman socket (for example, `$XDG_RUNTIME_DIR/podman/podman.sock`) with filesystem permissions restricted to the runtime-agent service account.
- Never expose the Podman API over a public TCP interface. The agent must access it through the Unix socket only.
- Preload a trusted, pinned Node runtime image; do not allow customer requests to select or pull images.
- Configure a dedicated network and an ingress proxy before enabling website execution. Do not publish container ports directly to the public internet.

## Required environment

- `RUNTIME_AGENT_SHARED_SECRET`: same random secret as the D Hosting API; at least 32 UTF-8 bytes.
- `RUNTIME_AGENT_DATABASE_URL`: dedicated runtime-agent PostgreSQL database.
- `RUNTIME_AGENT_STORAGE_ROOT`: absolute private directory for immutable runtime artifacts, outside any web root.
- `RUNTIME_AGENT_PERSISTENT_STORAGE_ROOT`: absolute private host directory for durable per-website data. Back it up separately; it must be writable by the runtime-agent service account and accessible to the local Podman service.
- Builder settings in `.env.example` are optional. Keep both enable flags false until the dedicated Linux host and firewall policy are verified. Never set the npm egress acknowledgement based only on application configuration.
- `RUNTIME_AGENT_HOST`: optional bind IP; defaults to `127.0.0.1`.
- `RUNTIME_AGENT_PORT`: optional TCP port; defaults to `5003`.
- `RUNTIME_AGENT_DB_SSL=true`: certificate-verified PostgreSQL TLS when required.

## Owner-scoped D Hosting runtime API\n\nOnce the private agent is reachable, D Hosting can query `GET /api/v1/projects/:projectId/resources/:resourceId/runtime`, retrieve bounded logs from `GET .../:resourceId/runtime/logs`, and call `POST .../:resourceId/runtime/stop` or `POST .../:resourceId/runtime/restart`. These endpoints require the website owner's D Hosting session. They do not enable runtime creation; the agent still returns HTTP 503 while execution is hard-disabled.\n\n## Local verification

```powershell
npm.cmd test
npm.cmd run typecheck
``

Do not expose this service publicly. For remote connectivity, bind the agent only to a private interface behind HTTPS and firewall rules allowing only the D Hosting API.


## Persistent storage lifecycle: Linux host provisioning

The code now includes a scheduled backup worker, authenticated owner-scoped backup/restore/usage routes, an audit table, encrypted snapshots, retention pruning, and XFS project hard quotas. Runtime startup fails closed if the per-site quota cannot be applied.

### Backup destination and key

- Set `RUNTIME_AGENT_BACKUP_KEY` to a base64-encoded random 32-byte key injected from the host secret manager. Keep it separate from the runtime HMAC and database credentials. Back up this key securely; losing it makes snapshots unrecoverable.
- Set `RUNTIME_AGENT_BACKUP_ROOT` to a mounted **remote NFS/NFS4 or SMB/CIFS filesystem**. Startup checks the filesystem type and source and refuses a local directory or the live-storage filesystem.
- Configure `RUNTIME_AGENT_BACKUP_INTERVAL_MS` (default 24 hours) and `RUNTIME_AGENT_BACKUP_RETENTION_DAYS` (default 30). Each cycle is single-flight, records backup metadata/audit events, and prunes only that resource's expired snapshots. Shutdown drains an active cycle before closing PostgreSQL.
- Backups are compressed and AES-256-GCM encrypted before being written to the remote mount. The remote share must itself have server-side access controls, encryption at rest, independent snapshots/versioning, and monitoring. The application does not provision an NFS/SMB server or manage its credentials.

### Hard quota helper

The runtime agent stays unprivileged. Install the helper and its root-owned storage-root configuration from `deploy/`:

1. Install `deploy/dsquare-xfs-project-quota` as `/usr/local/sbin/dsquare-xfs-project-quota`, owned by root and mode `0755`.
2. Create `/etc/dsquare-hosting-agent/persistent-storage-root` containing the exact canonical persistent storage path (example: `/var/lib/dsquare-hosting-agent/persistent-sites`). The file and parent directory must be root-owned and not writable by the runtime-agent account.
3. Install `deploy/dsquare-hosting-runtime-agent.sudoers` as `/etc/sudoers.d/dsquare-hosting-runtime-agent` after replacing the example service account with the dedicated runtime-agent account. Validate it with `visudo -cf`.
4. Mount the persistent storage filesystem as XFS with `prjquota` (or `pquota`) enabled. The helper validates the filesystem and target path again before assigning the project ID, enabling inheritance, and applying the hard block limit.
5. Set `RUNTIME_AGENT_XFS_QUOTA_HELPER` only if the helper is installed at a non-default absolute path.

The helper accepts only a UUID, numeric project ID, and numeric byte limit; it does not accept shell commands or arbitrary filesystem paths from the API. The sudoers rule permits only this helper. XFS quota granularity is 1 KiB, and the helper rounds down so the effective hard limit does not exceed the requested byte limit. Project IDs are reserved in PostgreSQL with a unique constraint and are not to be reused while website data or tombstones remain.

### Restore and deletion safeguards

- Restore requires a provisioned hard-quota record. The restored directory receives its XFS project ID and inheritance flag **before** the previous live directory is discarded. If quota reapplication fails, the previous directory is put back.
- Owner-facing restore and tombstone operations require the website to be stopped/archived as appropriate. Audit records are written for backup creation, restore, deletion, and tombstoning.
- Tombstoning moves data to a private hidden directory; it does not permanently erase it. A separate operator-approved purge/retention process is still required before physical deletion of tombstones.
- Scheduled retention prunes expired backup files and reconciles missing metadata. It does not purge tombstoned website data.

### Remaining live acceptance

Repository tests and CI do not prove the remote share, XFS mount flags, sudoers policy, rootless Podman UID mapping, quota exhaustion behavior, or restore rollback on the actual Linux host. Those checks must be completed on the dedicated Linux host before enabling customer runtime execution. The runtime agent continues to pass `executionEnabled: false`; this work does not turn on customer code execution.
