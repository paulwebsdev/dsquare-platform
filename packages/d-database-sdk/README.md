# @dsquare/d-database

Server-side JavaScript/TypeScript SDK for connecting an application backend to a single D Database resource.

## Install

```bash
npm install @dsquare/d-database
```

The package is currently in the DSquare monorepo and has not yet been published to the npm registry.

## Create an API key

In D Database, create a developer API key for the exact project and database resource your application needs. Choose the minimum permissions:
- `read`: list tables and read paginated rows.
- `write`: insert, update, and delete rows (the key must also have `read` if it needs read operations).

Keys can be revoked. The secret is shown only once when created.

## Server-side usage

Keep the API key in your backend environment, never in frontend source code, browser storage, a mobile app bundle, or a public repository.

```ts
import { createDDatabaseClient } from "@dsquare/d-database";

const db = createDDatabaseClient({
  baseUrl: process.env.D_DATABASE_URL!,
  apiKey: process.env.D_DATABASE_API_KEY!,
  projectId: process.env.D_DATABASE_PROJECT_ID!,
  resourceId: process.env.D_DATABASE_RESOURCE_ID!,
});

const tables = await db.listTables();
const customers = await db.select("customers", { limit: 25, offset: 0 });
const created = await db.insert("customers", {
  name: "Ada Lovelace",
  email: "ada@example.com",
});
await db.update("customers", { name: "Ada Byron" }, { email: "ada@example.com" });
await db.delete("customers", { email: "ada@example.com" });

// Efficient keyset pagination for large tables.
const firstPage = await db.selectCursor("customers", { limit: 25 });
if (firstPage.nextCursor) {
  const nextPage = await db.selectCursor("customers", { limit: 25, cursor: firstPage.nextCursor });
}

// These operations commit together or all roll back.
const result = await db.transaction([
  { type: "insert", table: "customers", values: { name: "Grace", email: "grace@example.com" } },
  { type: "update", table: "customers", values: { name: "Grace Hopper" }, where: { email: "grace@example.com" } },
]);
```

## Browser applications

Do not call this server SDK directly from browser code: its secret API key must remain on your application server. Expose your own authenticated application endpoint to the browser. A separate publishable-key browser client will only be appropriate after D Database has resource-level public access policies and row-level authorization.

## Current API surface

- `listTables()`
- `select(table, { limit, offset })`
- `selectCursor(table, { limit, cursor })` — keyset pagination (requires a single-column primary key).
- `transaction(operations)` — atomic group of 1–20 insert/update/delete operations.
- `insert(table, values)`
- `update(table, values, where)`
- `delete(table, where)`

Reads are paginated (1–100 rows per request). Table and column names are validated and values are parameterized. Update and delete operations require explicit equality filters; empty filters are rejected to prevent accidental whole-table mutations. Transactions use one PostgreSQL transaction and roll back the complete batch if any operation fails. Cursor pagination avoids large OFFSET scans and returns an opaque continuation cursor. Both methods use the same resource-scoped API key and server-side HTTPS endpoint. Realtime subscriptions and browser-direct access are not included.
