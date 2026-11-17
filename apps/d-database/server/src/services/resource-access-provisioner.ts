import { Pool } from "pg";
import { pool } from "../config/database.js";
import { createResourceAccessPlan } from "./resource-access-policy.js";
import { getResourceAccessLimits } from "./resource-access-limits.js";

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
  connectionLimit: number;
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

  const schemaName = String(resourceResult.rows[0].schema_name);
  const ownerResult = await pool.query(
    `SELECT owner.rolname AS schema_owner
     FROM pg_namespace AS namespace
     JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
     WHERE namespace.nspname = $1`,
    [schemaName],
  );
  const schemaOwner = String(ownerResult.rows[0]?.schema_owner || "");
  if (schemaOwner !== "d_database_app") {
    throw new Error("Resource schema is not owned by the D Database application role.");
  }

  const databaseResult = await pool.query(
    "SELECT current_database() AS database_name",
  );
  const databaseName = String(databaseResult.rows[0]?.database_name || "");
  const limits = getResourceAccessLimits(process.env);
  const plan = createResourceAccessPlan({
    resourceId,
    schemaName,
    databaseName,
    schemaOwner,
    limits,
  });

  const client = await resourceProvisionerPool.connect();
  try {
    await client.query("BEGIN");

    const provisionerIdentity = await client.query(`
      SELECT current_user AS role_name, role.rolsuper, role.rolcreatedb, role.rolcreaterole,
        pg_has_role(current_user, 'd_database_app', 'MEMBER') AS can_set_app_role,
        pg_has_role(current_user, 'pg_signal_backend', 'MEMBER') AS can_terminate_resource_sessions
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    const identity = provisionerIdentity.rows[0];
    if (
      !identity ||
      identity.role_name !== "d_database_provisioner" ||
      identity.rolsuper ||
      identity.rolcreatedb ||
      !identity.rolcreaterole ||
      !identity.can_set_app_role ||
      !identity.can_terminate_resource_sessions
    ) {
      throw new Error(
        "The dedicated provisioner role must be non-superuser with CREATEROLE, SET membership in d_database_app, and pg_signal_backend membership.",
      );
    }

    const provisionerDatabaseResult = await client.query(
      "SELECT current_database() AS database_name",
    );
    const provisionerDatabaseName = String(
      provisionerDatabaseResult.rows[0]?.database_name || "",
    );
    if (provisionerDatabaseName !== databaseName) {
      throw new Error("Provisioner connection points to a different database.");
    }

    const provisionerOwnerResult = await client.query(
      `SELECT owner.rolname AS schema_owner
       FROM pg_namespace AS namespace
       JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
       WHERE namespace.nspname = $1`,
      [schemaName],
    );
    const provisionerSchemaOwner = String(
      provisionerOwnerResult.rows[0]?.schema_owner || "",
    );
    if (provisionerSchemaOwner !== "d_database_app") {
      throw new Error("Provisioner database resource schema ownership does not match.");
    }

    // The provisioner performs role administration. It must not SET ROLE to
    // d_database_app for CREATE/ALTER ROLE; the application role stays free
    // of CREATEROLE. Metadata and schema grants run under the schema owner.
    await client.query("SET ROLE d_database_app");
    const existing = await client.query(
      "SELECT role_name, status FROM resource_access_grants WHERE resource_id = $1 FOR UPDATE",
      [resourceId],
    );
    if (existing.rowCount && existing.rows[0].status === "active") {
      throw new Error("This resource already has an active access grant.");
    }
    if (existing.rowCount && String(existing.rows[0].role_name) !== plan.roleName) {
      throw new Error("Stored resource access role does not match the resource.");
    }
    await client.query("RESET ROLE");

    if (existing.rowCount) {
      await client.query(
        `ALTER ROLE "${plan.roleName}" LOGIN PASSWORD '${plan.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    } else {
      await client.query(plan.createRole);
    }
    for (const statement of plan.configureStatements) {
      await client.query(statement);
    }
    for (const statement of plan.provisionerStatements) {
      await client.query(statement);
    }

    await client.query("SET ROLE d_database_app");
    for (const statement of plan.grantStatements) {
      await client.query(statement);
    }
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
    return { roleName: plan.roleName, password: plan.password, connectionLimit: limits.connectionLimit };
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
    const [applicationDatabase, provisionerDatabase] = await Promise.all([
      pool.query("SELECT current_database() AS database_name"),
      client.query("SELECT current_database() AS database_name"),
    ]);
    if (applicationDatabase.rows[0]?.database_name !== provisionerDatabase.rows[0]?.database_name) {
      throw new Error("Provisioner connection points to a different database.");
    }
    const provisionerIdentity = await client.query(`
      SELECT current_user AS role_name, role.rolsuper, role.rolcreaterole,
        pg_has_role(current_user, 'd_database_app', 'MEMBER') AS can_set_app_role,
        pg_has_role(current_user, 'pg_signal_backend', 'MEMBER') AS can_terminate_resource_sessions
      FROM pg_roles AS role
      WHERE role.rolname = current_user
    `);
    const identity = provisionerIdentity.rows[0];
    if (
      !identity ||
      identity.role_name !== "d_database_provisioner" ||
      identity.rolsuper ||
      identity.rolcreatedb ||
      !identity.rolcreaterole ||
      !identity.can_set_app_role ||
      !identity.can_terminate_resource_sessions
    ) {
      throw new Error(
        "The dedicated provisioner role must be non-superuser with CREATEROLE, SET membership in d_database_app, and pg_signal_backend membership.",
      );
    }

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

    // Only the dedicated CREATEROLE provisioner can disable customer logins.
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
