# DSquare Platform — Storage Architecture

## 1. Purpose
Defines how the platform stores, serves, protects and deletes uploaded files and generated artifacts.

## 2. Core Decisions
- PostgreSQL stores structured data and file metadata; private object storage holds large files and deployment artifacts.
- D Database and D Hosting maintain separate product ownership and access boundaries.
- Object identifiers and URLs do not grant access.
- All file operations require backend authorization and tenant ownership checks.
- Files remain private unless an explicitly authorized sharing or publishing operation makes them available.

## 3. Ownership and Isolation
Every stored object must have an authoritative product, tenant and owning-resource relationship.
- Derive tenant context from trusted backend authorization.
- Enforce ownership for upload, listing, download, replacement and deletion.
- Prevent cross-tenant access, including through guessed identifiers or altered URLs.
- Keep product-specific storage configuration and access policies separate.

## 4. Upload Handling
Before accepting a file, the backend must:
- Enforce configured size and quota limits.
- Validate allowed file types using more than the filename extension.
- Generate safe storage identifiers rather than trusting user-supplied paths.
- Apply required scanning or content checks before making the file available.
- Record ownership, size, detected type, creation time and retention state.
- Keep unvalidated uploads private and isolated.

## 5. Access and Delivery
- Authorize each operation on the backend.
- Use short-lived, scoped access links where appropriate.
- Do not expose storage credentials or unrestricted bucket access to clients.
- Prevent path traversal and unauthorized object enumeration.
- Apply appropriate content-disposition and content-type handling.
- Public delivery must be an explicit, authorized action with defined scope.

## 6. Retention and Deletion
- Define retention rules for uploads, generated artifacts, logs and temporary files.
- Deletion must remove or schedule removal of associated objects and metadata.
- Account for backups, legal retention and recovery requirements.
- Do not silently retain deleted customer files beyond the documented policy.

## 7. Reliability and Operations
- Handle storage timeouts and partial failures safely.
- Make retries idempotent where practical.
- Monitor storage usage, errors and capacity.
- Define backup and recovery expectations for critical metadata and objects.
- Verify that restoration preserves product and tenant boundaries.

## 8. Testing
Test upload validation, quota enforcement, ownership checks, signed-link scope and expiry, unauthorized access, deletion, retention, failure handling and recovery.

## 9. Status
Approved storage architecture baseline.

## 10. Product Storage Boundaries
D Database and D Hosting must use separate storage access identities and product-scoped storage locations or equivalent enforced boundaries. A service must not gain access to another product's objects merely because it knows an object identifier.

