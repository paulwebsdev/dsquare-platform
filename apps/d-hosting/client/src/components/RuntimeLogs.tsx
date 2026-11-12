import { useState } from "react";

type Props = { resourceUrl: string };

export default function RuntimeLogs({ resourceUrl }: Props) {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${resourceUrl}/runtime/logs`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json() as { logs?: string; message?: string };
      if (!response.ok) throw new Error(data.message || "Runtime logs are unavailable.");
      setLogs(typeof data.logs === "string" ? data.logs : "");
      setUpdatedAt(new Date().toLocaleTimeString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime logs are unavailable.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="panel wb-panel">
      <div className="panel-heading">
        <div>
          <h2>Backend runtime logs</h2>
          <p>Latest output from the isolated Node.js process. Secrets are redacted by the runtime agent.</p>
        </div>
        <button className="secondary-button" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing..." : "Refresh logs"}
        </button>
      </div>
      {error && <div className="wb-help" role="alert">{error}</div>}
      {updatedAt && <p className="wb-help">Last refreshed at {updatedAt}</p>}
      {logs ? (
        <pre className="wb-runtime-logs" aria-label="Backend runtime logs">{logs}</pre>
      ) : !error && !loading ? (
        <p className="wb-help">Logs have not been loaded. Refresh to retrieve the latest output. Logs are available only while the private runtime agent and website process are available.</p>
      ) : null}
    </article>
  );
}
