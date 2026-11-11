import { useCallback, useEffect, useState } from "react";

type Deployment = {
  id: string;
  deployment_number: number;
  status: "running" | "succeeded" | "failed";
  file_manifest: { original_name: string }[];
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
  is_active?: boolean;
};

type DeploymentHistoryProps = {
  resourceUrl: string;
};

export default function DeploymentHistory({ resourceUrl }: DeploymentHistoryProps) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [activating, setActivating] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadDeployments = useCallback(async () => {
    setError("");
    try {
      const response = await fetch(`${resourceUrl}/deployments`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load deployments.");
      setDeployments(data.deployments || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load deployments.");
    } finally {
      setLoading(false);
    }
  }, [resourceUrl]);

  useEffect(() => {
    void loadDeployments();
  }, [loadDeployments]);

  async function deploy() {
    setDeploying(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/deployments`, { method: "POST" });
      const data = await response.json();
      if (data.deployment) {
        setDeployments(current => [data.deployment, ...current].slice(0, 20));
      }
      if (!response.ok || !data.success) {
        throw new Error(data.message || "Deployment failed.");
      }
      setNotice(`Deployment #${data.deployment.deployment_number} saved as an immutable version. Activate it to publish.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed.");
      await loadDeployments();
    } finally {
      setDeploying(false);
    }
  }

  async function activate(deployment: Deployment) {
    const action = deployments.some(item => item.is_active) ? "roll back to" : "publish";
    if (!window.confirm(`Are you sure you want to ${action} deployment #${deployment.deployment_number}?`)) return;

    setActivating(deployment.id);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/deployments/${deployment.id}/activate`, { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || "Could not activate deployment.");
      setNotice(`Deployment #${deployment.deployment_number} is now the live version.`);
      await loadDeployments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not activate deployment.");
    } finally {
      setActivating("");
    }
  }

  return (
    <section className="panel wb-panel" aria-labelledby="deployment-heading">
      <div className="panel-heading">
        <div>
          <h2 id="deployment-heading">Deployments</h2>
          <p>Create immutable website versions, publish one, or roll back to an earlier successful version.</p>
        </div>
        <button className="primary-button" onClick={() => void deploy()} disabled={deploying}>
          {deploying ? "Creating snapshot..." : "Deploy website"}
        </button>
      </div>

      <p className="wb-help">
        Each successful deployment stores its own copy of your website files. Later edits or deletions
        from the upload area will not change an existing deployment. Node.js backend execution remains disabled.
      </p>

      {notice && <p role="status">{notice}</p>}
      {error && <div className="pm-error" role="alert">{error}</div>}

      {loading ? (
        <p>Loading deployment history...</p>
      ) : deployments.length === 0 ? (
        <p>No deployment attempts yet. Deploy after uploading your website files.</p>
      ) : (
        <div className="wb-file-list">
          {deployments.map(deployment => (
            <div className="wb-file-row" key={deployment.id}>
              <div className="wb-file-info">
                <strong>Deployment #{deployment.deployment_number}{deployment.is_active ? " · Live" : ""}</strong>
                <small>
                  {deployment.file_manifest?.length || 0} files · {new Date(deployment.started_at).toLocaleString()}
                </small>
                {deployment.error_summary && <small role="alert">{deployment.error_summary}</small>}
              </div>
              <div className="wb-file-actions">
                <span className={`pm-status ${deployment.status === "succeeded" ? "active" : deployment.status}`}>
                  {deployment.status}
                </span>
                {deployment.status === "succeeded" && !deployment.is_active && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void activate(deployment)}
                    disabled={Boolean(activating)}
                  >
                    {activating === deployment.id ? "Activating..." : "Publish / Roll back"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
