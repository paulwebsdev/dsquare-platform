import type { Pool } from "pg";

export type RuntimeRecord = {
  resourceId: string;
  deploymentId: string;
  artifactId: string;
  containerId: string;
  state: "running" | "stopped" | "unknown";
};

/** Durable mapping between a Hosting deployment and its isolated Podman container. */
export class RuntimeRegistry {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_agent_runtimes (
        resource_id UUID PRIMARY KEY,
        deployment_id UUID NOT NULL,
        artifact_id UUID NOT NULL UNIQUE,
        container_id VARCHAR(64) NOT NULL UNIQUE,
        state VARCHAR(16) NOT NULL CHECK (state IN ('running', 'stopped', 'unknown')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS runtime_agent_runtimes_state_updated_idx ON runtime_agent_runtimes (state, updated_at)"
    );
  }

  async create(record: RuntimeRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO runtime_agent_runtimes
        (resource_id, deployment_id, artifact_id, container_id, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING resource_id`,
      [record.resourceId, record.deploymentId, record.artifactId, record.containerId, record.state],
    );
    return result.rowCount === 1;
  }

  async get(resourceId: string): Promise<RuntimeRecord | null> {
    const result = await this.pool.query(
      `SELECT resource_id, deployment_id, artifact_id, container_id, state
       FROM runtime_agent_runtimes WHERE resource_id = $1`,
      [resourceId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      resourceId: String(row.resource_id),
      deploymentId: String(row.deployment_id),
      artifactId: String(row.artifact_id),
      containerId: String(row.container_id),
      state: row.state === "running" || row.state === "stopped" ? row.state : "unknown",
    };
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
}
