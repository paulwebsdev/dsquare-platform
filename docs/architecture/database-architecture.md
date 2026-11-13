# DSquare Platform — Database Architecture

## 1. Purpose

This document defines how D Database and D Hosting store, access, protect and maintain structured data and files.

The products share approved database conventions and tooling, but maintain independent data boundaries.

## 2. Core Decisions

- PostgreSQL is the structured database technology.
- D Database and D Hosting have separate product databases and credentials.
- Customer-owned data must be isolated by tenant and enforced by trusted backend controls.
- Large files are stored in private object storage, not directly in PostgreSQL.
- Database access occurs through approved backend services and repositories.
- Migrations are versioned, discoverable and tracked; discovery does not authorize execution.
- Production schema changes require review, controlled execution and a recovery plan appropriate to their risk.

## 3. Product and Environment Separation

Each product must maintain its own:

- Database and connection configuration.
- Database roles and credentials.
- Schema and migration history.
- Product-specific tables and data.
- Backup and restoration procedures.
- Access policies.

Development, testing and production environments must use separate databases and credentials.

D Database must not use D Hosting's database credentials or directly query its internal tables, and vice versa.

Shared identity data may be accessed only through the approved shared authentication boundary. It must not become a general cross-product database access path.

## 4. Tenant and Resource Ownership

Every customer-owned resource must have an authoritative ownership relationship.

Requirements:

- Tenant context must come from trusted backend authentication and authorization.
- A client-supplied tenant ID is not proof of access.
- Queries and mutations must enforce tenant ownership.
- Resource IDs must not be treated as authorization.
- Background jobs and events must preserve the correct product and tenant context.
- Cross-tenant access must be denied unless an explicitly authorized platform operation permits it.

Tenant isolation must be tested, including attempts to access resources by guessing or substituting identifiers.

## 5. Data Modeling

- Use explicit primary keys and appropriate foreign keys.
- Define required fields, uniqueness and check constraints in the database where appropriate.
- Use transactions for operations that must succeed or fail together.
- Store timestamps consistently, preferably in UTC.
- Define deletion, retention and archival behavior for customer and operational data.
- Avoid duplicating data when a clear relationship or approved service boundary is more appropriate.
- Do not rely only on frontend validation for data integrity.

Schema design must account for tenant ownership, product ownership, authorization and expected query patterns.

## 6. Database Access Layer

Backend features must access PostgreSQL through approved services and repositories.

Requirements:

- Use parameterized queries or safe query-builder/ORM operations.
- Do not concatenate untrusted input into SQL.
- Do not use unrestricted administrator credentials for ordinary application operations.
- Apply least-privilege database roles.
- Keep credentials out of source control, frontend bundles, logs and API responses.
- Use controlled connection pools and handle connection failures safely.
- Keep transaction boundaries explicit.
- Do not expose raw database connections or unrestricted SQL execution to ordinary modules.

Any customer-facing SQL editor or database-management capability must use a separate, explicitly designed security boundary with scoped credentials, resource limits and auditing.

## 7. Schema and Migration System

Migrations must be:

- Versioned and attributable to a product or approved module.
- Discovered only from approved locations.
- Validated for identity, ordering, dependencies and compatibility.
- Recorded in a migration history with execution status and integrity information.
- Reviewed before execution in production.
- Executed by a controlled migration process, not automatically merely because a file was discovered.

The system must detect duplicate versions, missing dependencies and modified migrations that were already applied.

Where supported, migrations should use transactions. Operations that cannot safely run transactionally require explicit risk handling, backup/recovery planning and clear failure reporting.

A failed migration must not be reported as successful. Recovery procedures must be documented for high-risk changes.

## 8. Backups and Restoration

Each product requires a defined backup and restoration strategy.

It must specify:

- What data is backed up and how often.
- Retention periods.
- Protection and access controls for backup files.
- Backup integrity checks.
- Restoration procedures.
- Recovery objectives appropriate to the product and service tier.

Backups must not be considered reliable until restoration has been tested.

Restoration must preserve product and tenant boundaries and must not silently overwrite unrelated environments.

## 9. File and Object Storage

Images, videos, PDFs and other large files belong in private object storage.

PostgreSQL should store metadata and controlled references, such as:

- Object identifier.
- Owning product and tenant.
- Related resource.
- File size and validated media type.
- Creation time and retention state.

Requirements:

- Authorize upload, download, listing and deletion on the backend.
- Enforce tenant ownership and storage quotas.
- Use short-lived, scoped access links where appropriate.
- Treat file names and contents as untrusted.
- Prevent path traversal and unauthorized object access.
- Define retention and deletion behavior.
- Apply malware scanning where appropriate.

Object identifiers or URLs alone must never grant access.

## 10. Security, Privacy and Audit

- Apply least privilege to database users and operational roles.
- Protect credentials and encryption keys.
- Restrict access to production data.
- Avoid logging secrets, full credentials or unnecessary personal information.
- Record important administrative, security and data-management actions.
- Define retention and deletion requirements for personal and customer data.
- Investigate and handle suspected data exposure through the platform's security procedures.

## 11. Performance and Reliability

- Add indexes based on measured query patterns and constraints.
- Avoid unbounded queries and unrestricted table scans on customer-facing paths.
- Use pagination for potentially large result sets.
- Set reasonable query and connection timeouts.
- Monitor connection pool use, slow queries, storage growth and database errors.
- Use transactions and idempotent operations where appropriate.
- Plan capacity and resource limits for each product independently.

Performance changes must preserve authorization and tenant isolation.

## 12. Testing Requirements

Tests must cover:

- Schema constraints and relationships.
- Migration discovery, validation, ordering and failure handling.
- Transaction behavior.
- Authentication and authorization at data-access boundaries.
- Tenant isolation and cross-tenant denial.
- Product database separation.
- Backup integrity and restoration procedures.
- File metadata and object access controls.
- Connection failures and safe error handling.
- Regression and integration behavior.

## 13. Implementation Order

1. Finalize product database boundaries and local connection configuration.
2. Define shared database conventions and safe access patterns.
3. Define migration metadata, tracking and review workflow.
4. Define tenant ownership conventions.
5. Define backup and restoration requirements.
6. Define object-storage metadata and access boundaries.
7. Implement and test a minimal sample feature in each product.
8. Add monitoring and operational procedures before public launch.

## 14. Specification Status

This document is an approved database architecture baseline.

Before implementation, review product separation, tenant isolation, migration safety, data access, backup and restoration, file storage, and operational security.

Implementation must not begin until the architecture is reviewed and approved.

## 15. Final Rule

The database stores data; it does not decide who is allowed to access it.

Trusted backend controls must enforce product boundaries, tenant ownership, permissions, data integrity and safe schema changes.

## 16. Additional Implementation Requirements

### 16.1 Product Database Boundaries
D Database and D Hosting must use separate PostgreSQL databases and separate database roles, even when they run on the same PostgreSQL server. Each environment must have its own database configuration and credentials.

### 16.2 Tenant Context at the Data-Access Boundary
Approved data-access services and repositories must receive trusted product and tenant context from the backend authorization layer. They must enforce ownership consistently; tenant filtering must not depend only on individual feature developers remembering to add it.

### 16.3 Shared Identity Access
Products must use the approved shared authentication service or API for identity operations. They must not directly query or modify shared identity tables.

### 16.4 Migration Concurrency
Only one migration runner may apply migrations to a given product database and environment at a time. The migration system must prevent concurrent execution and report when another migration process holds the execution lock.

### 16.5 File Upload Validation
Before a file is accepted for use, the backend must enforce configured file-size limits, allowed file types and safe handling requirements. File extensions alone are not sufficient to validate file type. Files must remain private and unavailable to other users until authorization and required validation checks succeed.

### 16.6 Restoration Controls
Restoration must be limited to authorized operators, followed by integrity and application-level verification. Procedures must identify the exact product and environment being restored and prevent accidental overwriting of unrelated databases or environments. Tenant-level restoration, if offered, requires a separately designed and tested process.

## 17. D Database V1 query and transaction safeguards

The developer data API supports bounded, atomic write transactions through
`POST /api/v1/data/:projectId/:resourceId/transactions`. A request contains
1–20 insert, update or delete operations. Every operation is restricted to
the API key's single authorized resource schema, validates table and column
names against PostgreSQL metadata, uses parameterized row values, and rejects
unfiltered updates/deletes. The entire request uses one PostgreSQL transaction;
a failed operation rolls back the complete batch.

For large tables, the developer data API also exposes keyset pagination at
`GET /api/v1/data/:projectId/:resourceId/tables/:tableName/rows/cursor`.
It requires exactly one primary-key column, orders by that key, fetches at
most 101 rows, and returns a continuation cursor. Cursor values are opaque
base64url-encoded scalar primary-key values; they are always decoded and passed
as query parameters, never interpolated into SQL. Existing offset pagination
remains available for compatibility.

Table structure management supports regular/unique indexes, unique constraints,
same-resource foreign keys and simple CHECK constraints. CHECK expressions
are deliberately limited to one validated column, a fixed comparison
operator, and a safely escaped string, finite number or boolean value; arbitrary
SQL expressions are not accepted.

These endpoints remain subject to the existing developer API key scopes,
resource ownership checks, per-role PostgreSQL connection limits and query
timeouts. Production load, concurrency and rollback behavior must still be
validated during the final Linux acceptance phase.
