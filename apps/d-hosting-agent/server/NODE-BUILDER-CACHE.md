# D Hosting Node.js builder cache

## Trust boundary

The npm cache provisioner is a trusted Linux worker operation. It must not run in
the D Hosting API process or in a customer runtime. The worker must use the
approved Node.js 22 image and npm 10 toolchain, and its network policy must
restrict outbound traffic to explicitly approved npm registry/CDN endpoints.
Do not give the worker general-purpose outbound network access.

The worker must keep the cache signing key in its secret manager. The key must
be at least 32 bytes and must never be copied into a customer container, build
workspace, API response, or application log.

## Provision a cache

The trusted worker calls `provisionNodeBuildCache` with the exact uploaded
`package-lock.json`, a dedicated absolute Linux cache directory, and the
signing key:

```ts
const { attestation, packageCount } = await provisionNodeBuildCache({
  packageLockJson,
  cacheDirectory: "/var/lib/dsquare/hosting/npm-cache/<lockfile-id>",
  signingKey: cacheSigningKeyFromSecretManager,
});
```

The provisioner:

1. Accepts npm lockfile versions 2 and 3 only.
2. Accepts remote tarballs only from HTTPS `registry.npmjs.org` with SHA-512 SRI.
3. Downloads each exact lockfile tarball using `npm cache add`, with scripts,
   audit and funding hooks disabled.
4. Runs `npm cache verify` and independently hashes every required cached
   tarball from npm's content-addressed cache.
5. Enforces a 20 MiB lockfile limit, 1,000-package limit, 100 MiB per tarball,
   bounded command output, per-command timeouts and a 30-minute total timeout.
6. Produces an HMAC-signed attestation tied to the exact lockfile SHA-256,
   approved builder image and npm 10 version.

The cache directory is created with owner-only permissions. It is mounted read-only into the builder and is keyed by the exact lockfile SHA-256. Keep it isolated from other tenants and immutable after attestation. A failed download, cache
verification, or integrity check must fail the provisioning operation; it must
never produce an attestation.

## Build-time contract

The build plan accepts only an attestation whose HMAC is valid, whose lockfile
digest matches the exact uploaded lockfile, and whose signed inventory covers
every required package. The npm cache is mounted read-only at `/npm-cache`.

Dependency installation is strictly offline:

```sh
npm ci --offline --cache=/npm-cache --ignore-scripts --no-audit --no-fund
```

The build phase is also run with lifecycle scripts disabled:

```sh
npm run build --if-present --ignore-scripts
```

The builder container has no network. Customer package lifecycle hooks and
packages that require those hooks (including some native-module installation
flows) are not supported by this initial profile. Do not weaken the offline or
script restrictions to make an incompatible project build.

## Integrated builder path

The Runtime Agent now exposes an authenticated `POST /v1/builds` endpoint when
its builder is explicitly enabled. It verifies the uploaded source artifact,
provisions or verifies the exact lockfile cache on the trusted Linux agent,
creates a rootless networkless Podman builder, runs the offline install and
build phases, stops the entire builder container, packages the output (including
safe in-workspace npm binary links), stores the immutable runtime artifact, and
cleans the temporary builder workspace. Startup reconciliation removes builder
containers and workspaces left by an agent crash.

The Hosting API has a remote build-and-start pipeline. It uploads an immutable
source snapshot, requests the isolated build, starts the returned artifact,
waits for the runtime readiness probe, and only then records and activates the
Node deployment. Temporary source artifacts are deleted after the build.

The private ingress configuration renderer is also in place: it validates public hostnames, produces deterministic Caddy reverse-proxy routes to private runtime aliases, strips untrusted forwarded headers, and sets bounded upstream timeouts. The Caddy container lifecycle, authenticated domain-route synchronization, and DNS/TLS issuance checks are not yet wired end to end.

The builder requires a dedicated Linux host, rootless Podman, persistent cache and workspace roots, and an actual outbound firewall policy restricting cache provisioning to approved npm registry/CDN endpoints. Keep both builder and runtime execution disabled until the ingress container, route synchronization, rollback/redeployment, TLS, and Linux end-to-end acceptance are complete.
