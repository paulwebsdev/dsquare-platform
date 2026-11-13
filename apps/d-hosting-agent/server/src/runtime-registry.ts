import type { Pool } from "pg";

export type RuntimeRecord = {
  resourceId: string;
  deploymentId: string;
  artifactId: string;
  containerId: string | null;
  state: "creating" | "running" | "stopped" | "unknown";
};

/** Durable reservation and mapping between each immutable deployment and its Podman container. */
export class RuntimeRegistry {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    // Legacy table retained for safe in-place upgrade and compatibility with
    // older agents. New deployments use the deployment-scoped table below.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_agent_runtimes (
        resource_id UUID PRIMARY KEY,
        deployment_id UUID NOT NULL,
        artifact_id UUID NOT NULL UNIQUE,
        container_id VARCHAR(64) UNIQUE,
        state VARCHAR(16) NOT NULL CHECK (state IN ('creating', 'running', 'stopped', 'unknown')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query("ALTER TABLE runtime_agent_runtimes ALTER COLUMN container_id DROP NOT NULL");
    await this.pool.query("ALTER TABLE runtime_agent_runtimes DROP CONSTRAINT IF EXISTS runtime_agent_runtimes_state_check");
    await this.pool.query("ALTER TABLE runtime_agent_runtimes ADD CONSTRAINT runtime_agent_runtimes_state_check CHECK (state IN ('creating', 'running', 'stopped', 'unknown'))");
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS runtime_agent_runtimes_state_updated_idx ON runtime_agent_runtimes (state, updated_at)"
    );

    // A resource may now have multiple immutable runtime deployments at once.
    // This is the registry used by the deployment-specific API and blue/green
    // lifecycle; the resource_id index is intentionally non-unique.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_agent_deployments (
        deployment_id UUID PRIMARY KEY,
        resource_id UUID NOT NULL,
        artifact_id UUID NOT NULL UNIQUE,
        container_id VARCHAR(64) UNIQUE,
        state VARCHAR(16) NOT NULL CHECK (state IN ('creating', 'running', 'stopped', 'unknown')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS runtime_agent_deployments_resource_created_idx ON runtime_agent_deployments (resource_id, created_at DESC)"
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS runtime_agent_deployments_state_updated_idx ON runtime_agent_deployments (state, updated_at)"
    );
  }

  async reserveDeployment(record: Pick<RuntimeRecord, "resourceId" | "deploymentId" | "artifactId">): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO runtime_agent_deployments
        (resource_id, deployment_id, artifact_id, state)
       VALUES ($1, $2, $3, 'creating')
       ON CONFLICT DO NOTHING
       RETURNING deployment_id`,
      [record.resourceId, record.deploymentId, record.artifactId],
    );
    return result.rowCount === 1;
  }

  async completeDeployment(deploymentId: string, containerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE runtime_agent_deployments
       SET container_id = $2, state = 'running', updated_at = NOW()
       WHERE deployment_id = $1 AND state = 'creating' AND container_id IS NULL
       RETURNING deployment_id`,
      [deploymentId, containerId],
    );
    return result.rowCount === 1;
  }

  async getDeployment(deploymentId: string): Promise<RuntimeRecord | null> {
    const result = await this.pool.query(
      `SELECT resource_id, deployment_id, artifact_id, container_id, state
       FROM runtime_agent_deployments WHERE deployment_id = $1`,
      [deploymentId],
    );
    return this.mapRecord(result.rows[0] as Record<string, unknown> | undefined);
  }

  async listDeployments(): Promise<RuntimeRecord[]> {
    const result = await this.pool.query(
      `SELECT resource_id, deployment_id, artifact_id, container_id, state
       FROM runtime_agent_deployments ORDER BY created_at ASC`,
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapRecord(row)!).filter(Boolean);
  }

  async setDeploymentState(deploymentId: string, state: RuntimeRecord["state"]): Promise<void> {
    await this.pool.query(
      "UPDATE runtime_agent_deployments SET state = $2, updated_at = NOW() WHERE deployment_id = $1",
      [deploymentId, state],
    );
  }

  async deleteDeployment(deploymentId: string): Promise<void> {
    await this.pool.query("DELETE FROM runtime_agent_deployments WHERE deployment_id = $1", [deploymentId]);
  }

  private mapRecord(row?: Record<string, unknown>): RuntimeRecord | null {
    if (!row) return null;
    return {
      resourceId: String(row.resource_id),
      deploymentId: String(row.deployment_id),
      artifactId: String(row.artifact_id),
      containerId: row.container_id == null ? null : String(row.container_id),
      state: row.state === "creating" || row.state === "running" || row.state === "stopped"
        ? row.state : "unknown",
    };
  }

  /** Atomically reserves a website in the legacy resource-scoped registry. */
  async reserve(record: Pick<RuntimeRecord, "resourceId" | "deploymentId" | "artifactId">): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO runtime_agent_runtimes
        (resource_id, deployment_id, artifact_id, state)
       VALUES ($1, $2, $3, 'creating')
       ON CONFLICT DO NOTHING
       RETURNING resource_id`,
      [record.resourceId, record.deploymentId, record.artifactId],
    );
    return result.rowCount === 1;
  }

  async complete(resourceId: string, containerId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE runtime_agent_runtimes
       SET container_id = $2, state = 'running', updated_at = NOW()
       WHERE resource_id = $1 AND state = 'creating' AND container_id IS NULL
       RETURNING resource_id`,
      [resourceId, containerId],
    );
    return result.rowCount === 1;
  }

  async list(): Promise<RuntimeRecord[]> {
    const result = await this.pool.query(
      `SELECT resource_id, deployment_id, artifact_id, container_id, state
       FROM runtime_agent_runtimes ORDER BY created_at ASC`,
    );
    return result.rows.map((row: Record<string, unknown>) => this.mapRecord(row)!).filter(Boolean);
  }

  async get(resourceId: string): Promise<RuntimeRecord | null> {
    const result = await this.pool.query(
      `SELECT resource_id, deployment_id, artifact_id, container_id, state
       FROM runtime_agent_runtimes WHERE resource_id = $1`,
      [resourceId],
    );
    return this.mapRecord(result.rows[0] as Record<string, unknown> | undefined);
  }

  async setState(resourceId: string, state: RuntimeRecord["state"]): Promise<void> {
    await this.pool.query(
      "UPDATE runtime_agent_runtimes SET state = $2, updated_at = NOW() WHERE resource_id = $1",
      [resourceId, state],
    );
  }

  async delete(resourceId: string): Promise<void> {
    await this.pool.query("DELETE FROM runtime_agent_runtimes WHERE resource_id = $1", [resourceId]);
  }

  async clearStaleReservations(): Promise<number> {
    const legacy = await this.pool.query(
      "DELETE FROM runtime_agent_runtimes WHERE state = 'creating' AND updated_at < NOW() - INTERVAL '10 minutes'",
    );
    const deployments = await this.pool.query(
      "DELETE FROM runtime_agent_deployments WHERE state = 'creating' AND updated_at < NOW() - INTERVAL '10 minutes'",
    );
    return (legacy.rowCount ?? 0) + (deployments.rowCount ?? 0);
  }
}
