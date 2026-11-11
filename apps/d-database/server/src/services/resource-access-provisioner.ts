import { Pool } from "pg";
import { pool } from "../config/database.js";
import { createResourceAccessPlan } from "./resource-access-policy.js";

const provisionerUrl = process.env.DB_PROVISIONER_URL?.trim();
export const resourceProvisionerPool = provisionerUrl
  ? new Pool({
      connectionString: provisionerUrl,
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      application_name: "dsquare-d-database-resource-provisioner",
      ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
    })
  : null;

export type ProvisionedResourceAccess = {
  roleName: string;
  password: string;
};

export async function provisionResourceAccess(
  resourceId: string,
): Promise<ProvisionedResourceAccess> {
  if (!resourceProvisionerPool) {
    throw new Error("Resource access provisioning is not configured.");
  }

  const resourceResult = await pool.query(
    `SELECT id, schema_name
     FROM database_resources
     WHERE id = $1 AND status = 'active'`,
    [resourceId],
  );
  if (resourceResult.rowCount !== 1) {
    throw new Error("Active database resource not found.");
  }

  const databaseResult = await pool.query(
    "SELECT current_database() AS database_name",
  );
  const databaseName = String(databaseResult.rows[0]?.database_name || "");
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName: String(resourceResult.rows[0].schema_name),
    databaseName,
    schemaOwner: "d_database_app",
  });

  const client = await resourceProvisionerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET ROLE d_database_app");
    const existing = await client.query(
      "SELECT role_name, status FROM resource_access_grants WHERE resource_id = $1 FOR UPDATE",
      [resourceId],
    );
    await client.query("RESET ROLE");
    if (existing.rowCount && existing.rows[0].status === "active") {
      throw new Error("This resource already has an active access grant.");
    }

    if (existing.rowCount) {
      const storedRole = String(existing.rows[0].role_name);
      if (storedRole !== plan.roleName) {
        throw new Error("Stored resource access role does not match the resource.");
      }
      await client.query(
        `ALTER ROLE "${plan.roleName}" LOGIN PASSWORD '${plan.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    } else {
      await client.query(plan.createRole);
    }
    for (const statement of plan.grantStatements) {
      await client.query(statement);
    }
    await client.query("SET ROLE d_database_app");
    await client.query(
      `INSERT INTO resource_access_grants (resource_id, role_name, status)
       VALUES ($1, $2, 'active')
       ON CONFLICT (resource_id) DO UPDATE
       SET role_name = EXCLUDED.role_name, status = 'active',
           created_at = NOW(), revoked_at = NULL`,
      [resourceId, plan.roleName],
    );
    await client.query("RESET ROLE");
    await client.query("COMMIT");
    return { roleName: plan.roleName, password: plan.password };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeResourceAccess(resourceId: string): Promise<void> {
  if (!resourceProvisionerPool) {
    throw new Error("Resource access provisioning is not configured.");
  }

  const client = await resourceProvisionerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET ROLE d_database_app");
    const grant = await client.query(
      `SELECT role_name FROM resource_access_grants
       WHERE resource_id = $1 AND status = 'active' FOR UPDATE`,
      [resourceId],
    );
    await client.query("RESET ROLE");
    if (grant.rowCount === 0) {
      await client.query("COMMIT");
      return;
    }

    const roleName = String(grant.rows[0].role_name);
    if (!/^dsq_app_[0-9a-f]{32}$/.test(roleName)) {
      throw new Error("Stored resource access role is invalid.");
    }
    await client.query(`ALTER ROLE "${roleName}" NOLOGIN`);
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()",
      [roleName],
    );
    await client.query("SET ROLE d_database_app");
    await client.query(
      `UPDATE resource_access_grants
       SET status = 'revoked', revoked_at = NOW()
       WHERE resource_id = $1`,
      [resourceId],
    );
    await client.query("RESET ROLE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
