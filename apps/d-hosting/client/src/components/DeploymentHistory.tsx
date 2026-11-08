import { useCallback, useEffect, useState } from "react";

type Deployment = {
  id: string;
  deployment_number: number;
  status: "running" | "succeeded" | "failed";
  file_manifest: { original_name: string }[];
  error_summary: string | null;
  started_at: string;
  finished_at: string | null;
};

type DeploymentHistoryProps = {
  resourceUrl: string;
};

export default function DeploymentHistory({ resourceUrl }: DeploymentHistoryProps) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
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
      setNotice(`Deployment #${data.deployment.deployment_number} passed validation.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed.");
      await loadDeployments();
    } finally {
      setDeploying(false);
    }
  }

  return (
    <section className="panel wb-panel" aria-labelledby="deployment-heading">
      <div className="panel-heading">
        <div>
          <h2 id="deployment-heading">Deployments</h2>
          <p>Validate the uploaded website and keep a record of each deployment attempt.</p>
        </div>
        <button className="primary-button" onClick={() => void deploy()} disabled={deploying}>
          {deploying ? "Validating..." : "Deploy website"}
        </button>
      </div>

      <p className="wb-help">
        This first deployment stage checks for a root homepage and verifies that every uploaded
        file exists in storage. It records a file manifest; live version switching and rollback
        are not enabled yet.
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
                <strong>Deployment #{deployment.deployment_number}</strong>
                <small>
                  {deployment.file_manifest?.length || 0} files · {new Date(deployment.started_at).toLocaleString()}
                </small>
                {deployment.error_summary && <small role="alert">{deployment.error_summary}</small>}
              </div>
              <span className={`pm-status ${deployment.status === "succeeded" ? "active" : deployment.status}`}>
                {deployment.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
