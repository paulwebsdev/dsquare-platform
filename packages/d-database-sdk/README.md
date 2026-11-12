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
- `write`: insert rows (the key must also have `read` if it needs read operations).

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
```

## Browser applications

Do not call this server SDK directly from browser code: its secret API key must remain on your application server. Expose your own authenticated application endpoint to the browser. A separate publishable-key browser client will only be appropriate after D Database has resource-level public access policies and row-level authorization.

## Current API surface

- `listTables()`
- `select(table, { limit, offset })`
- `insert(table, values)`

Reads are paginated (1–100 rows per request). Table and column names are validated and values are parameterized. Updates, deletes, transactions, realtime subscriptions, and browser-direct access are not part of this initial SDK release.
