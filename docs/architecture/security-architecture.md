# DSquare Platform — Security Architecture

## 1. Purpose
Defines platform-wide security boundaries and minimum controls for D Database, D Hosting and shared services.

## 2. Security Principles
- Backend authorization is authoritative.
- Apply least privilege and deny access by default.
- Treat client input, uploaded files, customer code and external requests as untrusted.
- Enforce product and tenant isolation across APIs, data, files, jobs, logs and deployments.
- Keep customer-controlled execution separate from platform control-plane processes.
- Record security-sensitive administrative actions.

## 3. Identity and Sessions
- Use the approved shared authentication architecture.
- Require verified accounts before protected product features.
- Use secure server-managed sessions and approved cookie protections.
- Enforce authorization on every protected backend operation.
- Support session expiry, rotation and revocation.

## 4. Product and Tenant Isolation
- Keep product databases, credentials, resources and permissions separate.
- Derive tenant context from trusted authentication and authorization.
- Never treat a client-supplied tenant or resource ID as proof of access.
- Test cross-tenant denial at API, repository, storage, job and runtime boundaries.
- Shared identity access must use the approved authentication boundary.

## 5. Secrets and Configuration
- Store secrets in an approved server-side mechanism.
- Never place secrets in frontend bundles, source control, deployment artifacts, logs or API responses.
- Restrict secret access to the specific service or runtime that needs it.
- Support controlled rotation and revoke compromised credentials.
- Separate configuration and credentials by environment.

## 6. Customer Code and Runtime Isolation
- Customer code must not execute in the main platform API or worker process.
- Backend execution remains disabled until isolation, resource limits, filesystem controls, network policy and secret handling are implemented and tested.
- Do not expose platform credentials, internal databases or other tenants' resources to customer code.
- Treat build commands and dependencies as untrusted.

## 7. API and Web Security
- Validate inputs with explicit schemas.
- Use parameterized database operations.
- Apply approved CORS, CSRF, cookie and rate-limit controls.
- Use safe error responses that do not reveal secrets or internal details.
- Apply idempotency to operations where retries could cause duplicate effects.
- Keep public application traffic separate from administrative control-plane APIs.

## 8. Files, Domains and Network Boundaries
- Authorize file operations and validate uploads.
- Verify custom-domain ownership before activation.
- Prevent domain or routing claims from crossing tenant boundaries.
- Restrict runtime network access according to an explicit policy.
- Do not allow customer workloads to reach sensitive internal services by default.

## 9. Monitoring and Incident Handling
- Record relevant security and administrative events.
- Redact secrets and avoid unnecessary personal data in logs.
- Define procedures for investigating, containing and recovering from suspected exposure.
- Revoke affected credentials and sessions when required.
- Notify affected parties when legally or contractually required.

## 10. Security Testing
Include authorization tests, tenant-isolation tests, input validation, secret-leak checks, dependency review, runtime-isolation tests and abuse/resource-limit tests.

## 11. Status
Approved security architecture baseline.

