import { useEffect, useState } from "react";

type Project = { id: string; name: string };
type Resource = { id: string; name: string; status: string };

export default function HostingApproval() {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state") || "";
  const clientId = params.get("client_id") || "";
  const [projects, setProjects] = useState<Project[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [projectId, setProjectId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || clientId !== "dsquare-d-hosting") {
      setError("This connection request is invalid. Return to D Hosting and try again.");
      setLoading(false);
      return;
    }
    fetch("/api/v1/projects")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Could not load projects.");
        setProjects(data.projects || []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load projects."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!projectId) {
      setResources([]);
      setResourceId("");
      return;
    }
    fetch(`/api/v1/projects/${projectId}/resources`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "Could not load resources.");
        setResources((data.resources || []).filter((item: Resource) => item.status === "active"));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load resources."));
  }, [projectId]);

  async function approve() {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/v1/integrations/hosting/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, projectId, resourceId }),
      });
      const data = await response.json();
      if (!response.ok || !data.success || !data.redirectUrl) {
        throw new Error(data.message || "Could not approve connection.");
      }
      window.location.assign(data.redirectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve connection.");
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: 620, margin: "8vh auto", padding: 24 }}>
      <section className="panel" style={{ padding: 28 }}>
        <p className="welcome-date">SECURE CONNECTION</p>
        <h1>Connect D Database</h1>
        <p>D Hosting is requesting permission to connect to one database resource you own.</p>
        <p><strong>Access is limited to the resource you select.</strong> You can revoke this connection later from D Hosting.</p>
        {error && <p role="alert" style={{ color: "#c0392b" }}>{error}</p>}
        {loading ? <p>Loading your database projects...</p> : (
          <>
            <label htmlFor="hosting-project">Choose a project</label>
            <select id="hosting-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ display: "block", width: "100%", padding: 12, margin: "8px 0 18px" }}>
              <option value="">Select a project</option>
              {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <label htmlFor="hosting-resource">Choose a database resource</label>
            <select id="hosting-resource" value={resourceId} onChange={(e) => setResourceId(e.target.value)} disabled={!projectId} style={{ display: "block", width: "100%", padding: 12, margin: "8px 0 18px" }}>
              <option value="">Select a resource</option>
              {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
            </select>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button className="primary-button" disabled={!resourceId || saving || !!error} onClick={approve}>{saving ? "Approving..." : "Approve connection"}</button>
              <button className="secondary-button" onClick={() => { window.location.href = "http://127.0.0.1:5174"; }}>Cancel</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
