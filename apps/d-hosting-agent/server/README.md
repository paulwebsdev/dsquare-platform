# D Hosting Runtime Agent (initial secure receiver)

This is a separate service workspace for a future Linux runtime host. It is not part of the D Hosting API process.

## Current safety state

- Authenticates every `/v1` request with the shared HMAC protocol used by D Hosting.
- Uses PostgreSQL-backed, single-use nonces to reject replayed requests.
- Accepts only bounded `DSQART01` artifact bundles and verifies the manifest and every file hash.
- Stores files in a private directory using exclusive file creation; it does not unpack archives or execute uploaded files.
- Runtime creation deliberately returns HTTP 503. No customer code is executed until a real isolated OCI provider is implemented and security-tested.
- The agent must run on a dedicated Linux host, not on the Windows development PC or inside the D Hosting API process.

## Required environment

Set these values in the agent host's private environment (never commit real secrets):

- `RUNTIME_AGENT_SHARED_SECRET`: the same random secret configured on the D Hosting API; at least 32 UTF-8 bytes.
- `RUNTIME_AGENT_DATABASE_URL`: connection string for a dedicated runtime-agent PostgreSQL database, not either product database.
- `RUNTIME_AGENT_STORAGE_ROOT`: absolute path to a private persistent directory outside any web root.
- `RUNTIME_AGENT_HOST`: optional bind IP; defaults to `127.0.0.1` so the service is not exposed on every network interface. Set a private interface IP only when remote Hosting API connectivity is configured.
- `RUNTIME_AGENT_PORT`: optional TCP port; defaults to `5003`.
- `GET /healthz` is a minimal liveness check; `GET /readyz` checks PostgreSQL connectivity and returns 503 when unavailable.
- `RUNTIME_AGENT_DB_SSL=true`: enable certificate-verified PostgreSQL TLS when required by the database host.

The database role currently needs permission to create the `runtime_agent_nonces` table and its expiry index at startup. Use a dedicated database/schema and do not reuse the D Hosting or D Database application roles.

## Local verification

From this directory:

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
```

Do not expose this service publicly yet. Keep the default loopback bind for local use. For a remote Linux host, bind only to its private interface IP, put it behind HTTPS, and configure firewall rules allowing only the D Hosting API to reach it. Never bind to a public interface directly.
