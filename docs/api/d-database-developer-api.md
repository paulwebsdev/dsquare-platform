# D Database Developer API

The D Database Developer API lets a trusted application access one active database resource with a resource-scoped API key.

## Base URL

Use the D Database API origin followed by `/api/v1`.

## Authentication

Send the API key from a trusted server using the Bearer authorization header:

```http
Authorization: Bearer dsq_live_<secret>
```

Never place API keys in browser JavaScript, mobile application bundles, source control, screenshots, or public logs. Store them in server-side environment variables or a secret manager.

Each key is bound to one project and one database resource. The API does not accept arbitrary SQL.

## Permissions

- `read`: list tables and read rows.
- `write`: insert, update, delete, and execute bounded write transactions.

A key must have the required scope for each endpoint. Read-only keys receive HTTP 403 when they call write endpoints.

## Key management

Key management endpoints use the signed-in D Database dashboard session, not a developer API key.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/projects/{projectId}/resources/{resourceId}/api-keys` | List key metadata; secret values are never returned. |
| POST | `/api/v1/projects/{projectId}/resources/{resourceId}/api-keys` | Create a resource-scoped key. The raw secret is returned once. |
| POST | `/api/v1/projects/{projectId}/resources/{resourceId}/api-keys/{keyId}/rotate` | Atomically issue a replacement and revoke the previous key. The replacement secret is returned once. |
| DELETE | `/api/v1/projects/{projectId}/resources/{resourceId}/api-keys/{keyId}` | Revoke a key while retaining its audit metadata. |

Rotation preserves the key name, scopes, and original expiry. The old key is revoked in the same database transaction that stores the replacement. Update your application with the new secret immediately after rotating; the old secret will no longer authenticate.

Key creation and rotation responses use `Cache-Control: no-store`. Copy the secret when it is shown; it cannot be retrieved later.

## Data endpoints

All data endpoints use the resource-bound Bearer key.

| Method | Endpoint | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/data/{projectId}/{resourceId}/tables` | read | List tables in the resource. |
| GET | `/api/v1/data/{projectId}/{resourceId}/tables/{table}/rows` | read | Read a bounded page using limit/offset. |
| GET | `/api/v1/data/{projectId}/{resourceId}/tables/{table}/rows/cursor` | read | Read a keyset-paginated page. |
| POST | `/api/v1/data/{projectId}/{resourceId}/tables/{table}/rows` | write | Insert one row using a `values` object. |
| PATCH | `/api/v1/data/{projectId}/{resourceId}/tables/{table}/rows` | write | Update rows using `values` and explicit equality `where` filters. |
| DELETE | `/api/v1/data/{projectId}/{resourceId}/tables/{table}/rows` | write | Delete rows using explicit equality `where` filters. |
| POST | `/api/v1/data/{projectId}/{resourceId}/transactions` | write | Execute a bounded atomic batch of insert/update/delete operations. |

Arbitrary SQL is not accepted. Table and column identifiers are validated against the selected resource schema, and values are parameterized. Update and delete operations require non-empty filters.

## Rate limits

Developer API requests are limited per API key using a PostgreSQL-backed fixed window, so the limit is consistent across service instances and restarts. The default is 300 requests per key per 60 seconds. When the limit is exceeded, the API returns HTTP 429 with a `Retry-After` header and `RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` headers. Configure `D_DATABASE_API_RATE_LIMIT_REQUESTS` and `D_DATABASE_API_RATE_LIMIT_WINDOW_MS` on the trusted D Database server to change the policy.

## Pagination

Offset pagination accepts `limit` (1–100) and `offset` (non-negative, bounded). Cursor pagination accepts `limit` (1–100) and an opaque `cursor`; it requires a table with exactly one primary-key column.

Prefer cursor pagination for large tables because it avoids increasingly expensive offset scans and does not require a full-table count.

## Transactions

A transaction request contains an `operations` array with 1–20 operations. Supported operation types are `insert`, `update`, and `delete`. Every update and delete must include explicit equality filters. If any operation fails validation or violates a database constraint, the transaction is rolled back.

## Common responses

- `400`: invalid identifier, request shape, pagination value, or filter.
- `401`: missing, malformed, invalid, expired, or revoked API key.
- `403`: key does not have the required permission.
- `404`: project, resource, table, or key is not available to the authenticated owner.
- `409`: inactive resource, missing primary key for cursor pagination, or a database constraint conflict.
- `500`: unexpected server-side failure. The response does not expose SQL or credential details.

## SDK

Use the official `@dsquare/d-database` SDK for table listing, reads, cursor pagination, inserts, updates, deletes, and transactions. Keep the SDK API key on the server and pass it through a private environment variable.
