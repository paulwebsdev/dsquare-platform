import { useEffect, useState } from "react";

type Connection = {
  id: string;
  database_project_id: string;
  database_resource_id: string;
  resource_name: string;
  status: "active" | "revoked";
  connected_at: string;
  revoked_at: string | null;
};

export default function DatabaseConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadConnections() {
    setLoading(true);
    try {
      const response = await fetch("/api/v1/database-connections");
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load connections.");
      setConnections(data.connections || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load connections.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (window.location.pathname === "/integrations/database/callback") {
      window.history.replaceState({}, document.title, "/");
      if (!code || !state) {
        setError("The D Database response is incomplete. Start the connection again.");
        void loadConnections();
        return;
      }
      setBusy(true);
      fetch("/api/v1/database-connections/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok || !data.success) throw new Error(data.message || "Connection could not be completed.");
          setNotice("D Database resource connected successfully.");
        })
        .catch((err) => setError(err instanceof Error ? err.message : "Connection failed."))
        .finally(() => { setBusy(false); void loadConnections(); });
    } else {
      void loadConnections();
    }
  }, []);

  async function startConnection() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch("/api/v1/database-connections/start", { method: "POST" });
      const data = await response.json();
      if (!response.ok || !data.authorizationUrl) throw new Error(data.message || "Could not start connection.");
      window.location.assign(data.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start connection.");
      setBusy(false);
    }
  }

  async function revoke(connection: Connection) {
    if (!window.confirm(`Disconnect "${connection.resource_name}" from D Hosting?`)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/database-connections/${connection.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not revoke connection.");
      setNotice("Database connection revoked.");
      await loadConnections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pm-page">
      <div className="pm-heading">
        <div>
          <div className="welcome-date">INTEGRATIONS</div>
          <h1>Database connections</h1>
          <p>Authorize D Hosting to receive encrypted connection credentials for a D Database resource. Per-website assignment and live application access are not enabled yet.</p>
        </div>
        <button className="primary-button" onClick={startConnection} disabled={busy}>＋ Connect D Database</button>
      </div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <div className="panel" role="status" style={{ padding: 14, marginBottom: 16 }}>{notice}</div>}
      <article className="panel" style={{ padding: 22 }}>
        <h2>Connected resources</h2>
        <p className="pm-card-description">Connections are securely stored and can be revoked here. They are not yet attached to individual websites, and Node.js execution remains disabled until the isolated runtime is deployed.</p>
        {busy && <p>Processing connection...</p>}
        {loading ? <p>Loading connections...</p> : connections.length === 0 ? (
          <p>No database resources connected yet. Connect a resource you own to get started.</p>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {connections.map((connection) => (
              <div key={connection.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap", borderBottom: "1px solid var(--border-color, #ddd)", padding: "12px 0" }}>
                <div>
                  <strong>{connection.resource_name}</strong>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>Resource ID: {connection.database_resource_id}</div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>Connected: {new Date(connection.connected_at).toLocaleString()}</div>
                  <div style={{ fontSize: 13 }}>Status: {connection.status}</div>
                </div>
                {connection.status === "active" && <button className="secondary-button" disabled={busy} onClick={() => void revoke(connection)}>Disconnect</button>}
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
