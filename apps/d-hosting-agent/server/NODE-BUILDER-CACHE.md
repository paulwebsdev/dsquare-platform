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

The cache directory is created with owner-only permissions. Keep it isolated
from other tenants and immutable after attestation. A failed download, cache
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

## Not yet wired

Unit 1 provides the policy, cache provisioning, integrity verification and
attestation primitives. Unit 2 must connect the provisioner to the isolated
builder lifecycle, safely transfer the cache/attestation, and mount the cache
read-only into the build container. Until then, Node.js execution remains
disabled.
