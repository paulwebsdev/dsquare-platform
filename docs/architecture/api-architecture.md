# DSquare Platform — API Architecture

## 1. Purpose

This document defines how the frontend, backend and feature modules communicate through APIs.

It applies to:
- D Database
- D Hosting

Both products use shared API standards while maintaining independent APIs, data, permissions and configurations.

## 2. Architecture Principles

- Use versioned REST APIs.
- Use HTTPS in production.
- Keep frontend and backend responsibilities separate.
- Validate all incoming requests on the server.
- Enforce authentication and authorization on the backend.
- Apply consistent response and error formats.
- Keep product resources isolated.
- Register approved module routes through the controlled API registry.
- Never expose database credentials or internal secrets to the frontend.

## 3. API Versioning

Initial API prefix:

`/api/v1/`

Examples:

- `/api/v1/auth`
- `/api/v1/projects`
- `/api/v1/hosting`

Rules:
- All public API routes must include a version.
- Breaking API changes require a new version.
- Compatible additions may remain within the current version.
- Deprecated endpoints must have a documented removal plan.
- Internal module routes must follow the same product API version.

D Database and D Hosting must maintain separate API deployments and configurations.

## 4. API Route Structure

Routes should follow this logical structure:

`/api/v1/{module}/{resource}`

Examples:

- `/api/v1/projects`
- `/api/v1/projects/:projectId`
- `/api/v1/storage/files`
- `/api/v1/deployments`

HTTP method conventions:

| Method | Purpose |
|---|---|
| GET | Retrieve data |
| POST | Create a resource or perform an action |
| PUT | Replace a resource |
| PATCH | Partially update a resource |
| DELETE | Delete a resource |

Routes must use predictable naming and must not expose internal database table names.

## 5. Frontend and Backend Communication

The frontend communicates with the backend through approved API clients.

Requirements:
- Use a centralized API client per product.
- Configure the API base URL through environment configuration.
- Support request and response typing.
- Handle authentication consistently.
- Handle loading, success and error states.
- Prevent unnecessary duplicate requests.
- Never put private server secrets in frontend environment variables.
- Validate all data again on the backend.

The frontend must not connect directly to the production database.

## 6. Request Validation

Every incoming request must be validated before reaching business logic.

Validation must cover:
- URL parameters.
- Query parameters.
- Request body.
- Required fields.
- Data types.
- String length limits.
- Numeric ranges.
- File type and file size where applicable.
- Allowed values.
- Ownership and access constraints.

Use approved shared validation utilities and schemas.

Invalid requests must be rejected with a consistent validation error response.

## 7. Standard Success Response

Successful API responses should follow a consistent structure.

Example:

```json
{
  "success": true,
  "message": "Request completed successfully.",
  "data": {}
}
```

List responses may include pagination metadata:

```json
{
  "success": true,
  "message": "Records retrieved successfully.",
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

Sensitive internal information must never be included in responses.

## 8. Standard Error Response

Errors should follow a predictable structure.

Example:

```json
{
  "success": false,
  "message": "The request could not be completed.",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": []
  }
}
```

Rules:
- Use appropriate HTTP status codes.
- Do not expose stack traces in production.
- Do not expose passwords, tokens or database credentials.
- Keep internal diagnostic details in protected server logs.
- Give users understandable error messages.
- Use stable machine-readable error codes.

## 9. Authentication

Authentication must be handled by approved shared authentication services.

The system must support:
- User registration.
- User login.
- Logout.
- Session or token validation.
- Password reset.
- Email verification where required.
- Account security controls.

The final authentication mechanism will be defined in the authentication architecture document.

Authentication must be enforced on protected backend routes.

## 10. Authorization

Authentication and authorization are separate.

Authentication establishes who the user is.

Authorization determines what the user is allowed to do.

Requirements:
- Check permissions on the backend.
- Verify resource ownership.
- Enforce role and account restrictions.
- Apply product-specific access policies.
- Prevent users from accessing another customer's resources.
- Never rely only on hidden frontend buttons or frontend route guards.

Module permissions and customer permissions must remain separate.

## 11. Middleware Pipeline

Protected API requests should follow this logical pipeline:

1. Request received.
2. Request ID assigned.
3. Security headers and origin policies applied.
4. Rate limit checked.
5. Authentication checked where required.
6. Request validated.
7. Authorization and resource ownership checked.
8. Route handler executed.
9. Response formatted.
10. Errors handled centrally.
11. Request safely logged.

The exact middleware order must be finalized during implementation and tested for security.

Public endpoints may use a reduced pipeline but must retain appropriate security controls.

## 12. Rate Limiting

Rate limiting must protect APIs against abuse and excessive requests.

Apply configurable limits based on:
- Endpoint sensitivity.
- Authentication status.
- User or account.
- IP address where appropriate.
- Resource consumption.

Authentication, password reset, file uploads and expensive operations require suitable limits.

Limits must be configurable without changing unrelated feature modules.

## 13. Automatic Module API Registration

Feature modules must register routes through the approved RouteRegistrar contract.

Requirements:
- Discover modules only from approved product locations.
- Validate module manifests before loading.
- Check approval and contract compatibility.
- Validate route definitions.
- Detect duplicate routes.
- Apply central security middleware.
- Enforce permissions.
- Register routes only after successful module initialization.
- Remove or disable module routes during controlled shutdown.
- Keep D Database and D Hosting route registries independent.

Adding an ordinary approved feature module should not require manually editing a central route file.

Automatic discovery must never mean unrestricted execution of arbitrary files.

## 14. Database Access

API handlers must not access the database using unrestricted administrator credentials.

Database operations must go through approved backend services and repositories.

Requirements:
- Parameterized queries.
- Resource ownership checks.
- Transaction support where needed.
- Controlled connection management.
- Safe error handling.
- Product and tenant isolation.
- No direct database credentials in frontend code.

The detailed database architecture will define schemas, migrations, transactions and storage relationships.

## 15. File and Storage APIs

File APIs must support the products' approved storage requirements.

Requirements:
- Validate file types and sizes.
- Enforce upload permissions.
- Use private storage by default.
- Generate controlled upload and download access.
- Prevent path traversal.
- Apply malware scanning where appropriate.
- Support safe deletion and retention policies.
- Avoid storing large binary files directly in PostgreSQL.

The detailed storage architecture will define object storage, upload workflows and access policies.

## 16. Pagination, Filtering and Sorting

List endpoints should support pagination where appropriate.

Standard query parameters may include:

- `page`
- `limit`
- `search`
- `sortBy`
- `sortOrder`

Rules:
- Validate all query parameters.
- Set reasonable maximum page sizes.
- Allow only approved sortable fields.
- Prevent expensive unrestricted queries.
- Enforce authorization before returning records.

## 17. API Documentation

The platform must maintain API documentation.

Documentation should describe:
- Endpoint path.
- HTTP method.
- Purpose.
- Authentication requirements.
- Required permissions.
- Request parameters.
- Request body.
- Success response.
- Error responses.
- Rate limits where relevant.

OpenAPI may be used to generate and maintain machine-readable API documentation.

Documentation must not expose private endpoints or internal secrets.

## 18. Logging and Monitoring

API activity should be logged safely.

Useful information includes:
- Request ID.
- Product.
- Module.
- Endpoint.
- HTTP method.
- Response status.
- Duration.
- Safe error code.

Never log:
- Passwords.
- Authentication tokens.
- Private keys.
- Full payment credentials.
- Sensitive personal information unnecessarily.

Monitoring should help identify failures, unusual traffic and performance problems.

## 19. Cross-Product Communication

D Database and D Hosting must not automatically access each other's internal APIs or data.

Future cross-product integration must use:
- Explicitly approved integration contracts.
- Authenticated service communication.
- Scoped permissions.
- Validated requests.
- Audit logging.
- Independent failure handling.

## 20. Testing Requirements

API tests must cover:
- Successful requests.
- Invalid request data.
- Authentication failures.
- Authorization failures.
- Resource ownership.
- Rate limiting.
- Route conflicts.
- Module registration.
- Product isolation.
- Error response consistency.
- Pagination.
- File upload restrictions.
- Database failure handling.
- Integration between frontend and backend.

Security tests must verify that users cannot access resources belonging to other accounts.

## 21. Implementation Order

1. Define shared API response types.
2. Define error response types.
3. Define API versioning and route conventions.
4. Define request validation standards.
5. Define authentication integration.
6. Define authorization middleware contracts.
7. Define route registration integration.
8. Define API client conventions.
9. Define logging and request IDs.
10. Define API documentation conventions.
11. Implement and test sample endpoints in both products.

## 22. Specification Status

This document is an approved API architecture baseline.

Before implementation, review:
- API conventions.
- Authentication boundaries.
- Authorization requirements.
- Request validation.
- Error handling.
- Module route registration.
- Product isolation.
- Security and testing requirements.

Implementation must not begin until the architecture is reviewed and approved.

## 23. Final Rule

Every API request must pass through the appropriate product security controls.

Modules may provide functionality, but the platform controls authentication, authorization, validation, route registration and access to protected resources.


## 24. Binding API Corrections

This section adds mandatory requirements and takes precedence over conflicting earlier wording.

### 24.1 Approved Authentication

- Use the approved shared DSquare identity with independent product access.
- Use server-managed sessions and secure HTTP-only cookies for browser sessions.
- Require email verification before protected product features are accessible.
- Enforce session validity and verification status on the backend.
- Do not store session identifiers in localStorage.

### 24.2 Tenant Isolation

- Establish tenant context through trusted backend authentication and authorization.
- Never trust a tenant ID supplied by the client as proof of access.
- Enforce tenant ownership on every resource query and operation.
- Apply isolation to files, background jobs, events, deployments and other customer-owned resources.
- Test attempts to access another tenant's resources, including by guessing resource identifiers.

### 24.3 Browser Security

- Configure CORS with explicit approved origins; do not use unrestricted origins with credentials.
- Protect cookie-authenticated state-changing requests against CSRF.
- Use secure cookie settings appropriate to the deployment, including HttpOnly, Secure in production and an appropriate SameSite policy.
- Validate request origins where appropriate.
- Never treat CORS as a substitute for authentication or authorization.

### 24.4 Idempotency and Safe Retries

- Define idempotency support for operations where retries could create duplicate resources, deployments, charges or other consequential actions.
- Scope idempotency keys to the authenticated account, operation and product.
- Store and validate the result associated with a key for a defined retention period.
- Reject reuse of a key with a materially different request.
- Do not claim an operation succeeded until its result is confirmed.

### 24.5 Background Jobs and Long-Running Operations

- Use controlled background jobs for operations that may exceed normal request limits, including applicable hosting deployments.
- Provide authenticated job-status endpoints.
- Enforce tenant and product ownership on job creation, status access, cancellation and results.
- Define retry limits, failure states, timeouts and safe logging.
- Do not expose worker credentials or internal job infrastructure to clients.

### 24.6 File and Storage Access

- Authorize uploads, downloads, listing and deletion on the backend.
- Enforce per-account and per-tenant storage quotas.
- Use private storage by default.
- Where signed upload or download links are used, make them short-lived, scoped to the intended object and operation, and avoid exposing them in logs.
- Validate file size and allowed types; treat filenames and file contents as untrusted.
- Apply malware scanning where appropriate and define safe retention and deletion behavior.
- Prevent one tenant from accessing another tenant's files.

### 24.7 API Compatibility and Deprecation

- Document compatibility guarantees for each public API version.
- Avoid breaking changes within a version.
- Provide a documented deprecation period and migration guidance before removing a public endpoint, except where urgent security action requires otherwise.
- Keep API documentation aligned with the deployed behavior.
- Test supported clients and module contracts for compatibility.

### 24.8 Enforcement

These requirements must be enforced by trusted backend controls and verified through automated tests. Frontend checks, TypeScript types and documentation alone do not provide security.


