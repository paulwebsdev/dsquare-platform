# D Hosting and D Database Integration

## Status

Proposed for v1 account linking. This document does not authorize website queries or grant D Hosting direct PostgreSQL credentials.

## Goals

- Let a signed-in D Hosting user explicitly connect one D Database resource they own.
- Keep D Hosting and D Database accounts, sessions, databases, and ownership boundaries separate.
- Support listing and revoking connections from D Hosting.
- Make authorization short-lived, single-use, scoped, and auditable.

## Non-goals for this stage

- Running website queries against D Database.
- Sharing PostgreSQL usernames/passwords or application connection pools.
- Matching accounts by email.
- Forwarding either product's session cookie or session token to the other product.
- Cross-product access to projects, resources, or customer data beyond the resource explicitly approved.

## Trust boundaries

D Database is authoritative for D Database users, projects, and resources. D Hosting is authoritative for D Hosting users and stored connection records. A browser redirect is only a transport for an opaque one-time code; it is not proof of authorization by itself.

The D Database backend must validate its own session cookie and verify that the selected resource belongs to the signed-in D Database user before issuing a code. The D Hosting backend must validate its own session and pending connection state before accepting a redeemed result.

## Authorization flow

1. D Hosting creates a cryptographically random state value and a pending connection record tied to the authenticated D Hosting user. Store only a SHA-256 hash of the state, with a short expiry (10 minutes).
2. The browser navigates to the configured D Database approval page with the state and a fixed, allow-listed D Hosting callback URL.
3. D Database requires its own signed-in session. The user selects a project/resource and explicitly approves the request.
4. D Database verifies ownership of the selected resource, creates a cryptographically random authorization code, stores only its SHA-256 hash with the D Database user, project, resource, client identifier, expiry (5 minutes), and unused status, then redirects to the allow-listed callback with the code and original state.
5. D Hosting callback submits the code and client credentials from its backend to the D Database redemption endpoint. The browser never receives or submits the client secret.
6. D Database atomically consumes the unexpired, unused code and returns only the approved D Database user/project/resource identifiers and display metadata. Redemption must be bound to the registered D Hosting client identifier.
7. D Hosting validates the pending state and authenticated D Hosting owner, then stores the connection mapping. If either validation fails, it must not create a connection.
8. D Hosting allows its owner to revoke a connection. Revocation disables the mapping immediately.

## Required safeguards

- HTTPS in deployed environments; local development may use the existing loopback origins.
- Exact callback URL allow-listing; do not accept arbitrary redirect URLs.
- At least 256 bits of entropy for state and authorization codes; store only hashes.
- Constant-time comparison for client-secret validation where applicable.
- Authorization code lifetime no longer than five minutes; state lifetime no longer than ten minutes; both single-use.
- Atomic code consumption in a database transaction to prevent replay.
- Bind each code to the D Hosting client identifier and the exact selected D Database resource.
- Require D Database resource ownership at approval time, not merely project existence.
- Validate the D Hosting session and state on callback; reject expired, missing, mismatched, or reused state.
- Never put passwords, session tokens, database credentials, or client secrets in URLs or browser storage.
- Do not log authorization codes, secrets, cookies, or raw state values.
- Add rate limits to authorization and redemption endpoints before public deployment.
- Revocation must be owner-scoped and idempotent.

## Persistence boundaries

D Database stores pending authorization codes in its own database. D Hosting stores pending connection state and active/revoked connection records in its own database. No user table or project table is shared.

A D Hosting connection record stores the D Hosting owner ID and the approved D Database resource ID (plus project ID and safe display metadata). It does not store PostgreSQL credentials. A future query proxy must re-check that the connection is active and must enforce the stored resource scope on every operation.

## Configuration

Use separate server-only environment variables for the D Database integration client identifier, client secret, D Hosting callback URL, and D Database base URL. Secrets must be generated locally, kept out of Git, and configured independently in each server environment. Never expose them through Vite-prefixed variables.

## Rollout

Implement and test account linking/revocation first. Do not enable website database queries until ownership, replay, expiry, CSRF/state, revocation, and cross-account isolation tests pass.
