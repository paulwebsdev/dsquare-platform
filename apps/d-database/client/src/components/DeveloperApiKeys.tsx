import { useEffect, useMemo, useState } from "react";

type Project = { id: string; name: string };
type Resource = { id: string; name: string; status: string };
type ApiKey = {
  id: string; name: string; key_prefix: string; scopes: string[];
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
};
type ApiResponse = { success?: boolean; message?: string; projects?: Project[]; resources?: Resource[]; keys?: ApiKey[]; key?: ApiKey; secret?: string };

export default function DeveloperApiKeys() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [projectId, setProjectId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("90");
  const [secret, setSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedProject = useMemo(() => projects.find((item) => item.id === projectId), [projects, projectId]);

  async function request(url: string, init?: RequestInit): Promise<ApiResponse> {
    const response = await fetch(url, { credentials: "same-origin", ...init });
    const data = await response.json() as ApiResponse;
    if (!response.ok) throw new Error(data.message || "The request could not be completed.");
    return data;
  }

  useEffect(() => {
    let active = true;
    request("/api/v1/projects")
      .then((data) => {
        if (!active) return;
        const list = data.projects || [];
        setProjects(list);
        setProjectId(list[0]?.id || "");
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load projects."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setResources([]);
    setResourceId("");
    setKeys([]);
    if (!projectId) return;
    request(`/api/v1/projects/${encodeURIComponent(projectId)}/resources`)
      .then((data) => {
        if (!active) return;
        const list = (data.resources || []).filter((item) => item.status === "active");
        setResources(list);
        setResourceId(list[0]?.id || "");
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load resources."); });
    return () => { active = false; };
  }, [projectId]);

  const loadKeys = async () => {
    if (!projectId || !resourceId) { setKeys([]); return; }
    const data = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/api-keys`);
    setKeys(data.keys || []);
  };

  useEffect(() => {
    let active = true;
    if (!projectId || !resourceId) { setKeys([]); return; }
    request(`/api/v1/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/api-keys`)
      .then((data) => { if (active) setKeys(data.keys || []); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load API keys."); });
    return () => { active = false; };
  }, [projectId, resourceId]);

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!read && !write) { setError("Choose at least one permission."); return; }
    setSaving(true); setError(""); setNotice(""); setSecret("");
    try {
      const data = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/api-keys`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes: [ ...(read ? ["read"] : []), ...(write ? ["write"] : []) ], expiresInDays: expiresInDays ? Number(expiresInDays) : undefined })
      });
      setSecret(data.secret || "");
      setName("");
      setNotice("API key created. Copy the secret now; it cannot be displayed again.");
      await loadKeys();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create API key."); }
    finally { setSaving(false); }
  }

  async function revokeKey(key: ApiKey) {
    if (!window.confirm(`Revoke “${key.name}”? Applications using this key will stop authenticating.`)) return;
    setError(""); setNotice("");
    try {
      await request(`/api/v1/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      setNotice("API key revoked.");
      await loadKeys();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke API key."); }
  }

  async function copySecret() {
    try { await navigator.clipboard.writeText(secret); setNotice("Secret copied. Store it securely in your server environment."); }
    catch { setError("Clipboard access failed. Select and copy the secret manually."); }
  }

  return (
    <section className="pm-page">
      <div className="pm-heading"><div><div className="welcome-date">DEVELOPER TOOLS</div><h1>API Keys</h1><p>Create secure access keys for your website or backend to connect to a D Database. Keep every secret key private.</p></div></div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <div className="pm-detail panel" role="status">{notice}</div>}
      {loading ? <div className="pm-empty panel"><div className="pm-spinner" /><strong>Loading projects...</strong></div> : (
        <>
          <article className="pm-detail panel">
            <div className="pm-form-heading"><div><h2>1. Choose your database</h2><p>Every key belongs to this one database only. It cannot open another project or database.</p></div></div>
            <label htmlFor="developer-project">Project</label>
            <select id="developer-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.length ? projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No projects available</option>}
            </select>
            <label htmlFor="developer-resource">Active database resource</label>
            <select id="developer-resource" value={resourceId} onChange={(event) => setResourceId(event.target.value)} disabled={!resources.length}>
              {resources.length ? resources.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No active resources in this project</option>}
            </select>
          </article>
          {resourceId ? <>
            <article className="pm-detail panel">
              <div className="pm-form-heading"><div><h2>2. Connect your website or application</h2><p>Use these settings in your website's private backend. Never add a secret key to website pages, browser JavaScript, or public code.</p></div></div>
              <p className="pm-card-description">Your backend needs these four settings. The values beginning with D_DATABASE_ are setting names; replace the example values with your own details:</p>
              <pre className="pm-code-block"><code>{`D_DATABASE_URL=https://your-d-database-api-origin\nD_DATABASE_PROJECT_ID=${projectId}\nD_DATABASE_RESOURCE_ID=${resourceId}\nD_DATABASE_API_KEY=dsq_live_your_secret`}</code></pre>
              <p className="pm-card-description">Example: how your backend connects to D Database</p>
              <pre className="pm-code-block"><code>{`import { createDDatabaseClient } from "@dsquare/d-database";\n\nconst db = createDDatabaseClient({\n  baseUrl: process.env.D_DATABASE_URL!,\n  apiKey: process.env.D_DATABASE_API_KEY!,\n  projectId: process.env.D_DATABASE_PROJECT_ID!,\n  resourceId: process.env.D_DATABASE_RESOURCE_ID!,\n});\n\nconst tables = await db.listTables();\nconst rows = await db.select("your_table", { limit: 25, offset: 0 });`}</code></pre>
              <p className="pm-card-description">Important: connect from your private server only. Do not connect directly from a visitor's browser.</p>
            </article>
            <article className="pm-detail panel">
              <div className="pm-form-heading"><div><h2>3. Create a secret API key</h2><p>This key gives your backend permission to use this database. Keep it private. Never share it or place it in browser code.</p></div></div>
              <form className="wb-form" onSubmit={createKey}>
                <label htmlFor="developer-key-name">Give this key a name</label>
                <input id="developer-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. Production website" required />
                <div className="pm-detail-meta">
                  <label><input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} /> Read database records</label>
                  <label><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /> Add and change records</label>
                </div>
                <label htmlFor="developer-key-expiry">When should this key expire?</label>
                <select id="developer-key-expiry" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
                  <option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option><option value="">Never (not recommended)</option>
                </select>
                <div className="pm-detail-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Creating..." : "Create secret key"}</button></div>
              </form>
            </article>
            {secret && <article className="pm-detail panel">
              <div className="pm-form-heading"><div><h2>Your new secret key</h2><p>Copy and save this key now. For security, DSquare will not show the full key again.</p></div></div>
              <textarea readOnly value={secret} rows={3} aria-label="New API secret" />
              <div className="pm-detail-actions"><button className="primary-button" type="button" onClick={() => void copySecret()}>Copy secret key</button><button className="secondary-button" type="button" onClick={() => setSecret("")}>I've saved my key</button></div>
            </article>}
            <article className="pm-detail panel">
              <div className="pm-form-heading"><div><h2>Your secret keys</h2><p>You can see each key's name, permissions and status here. Full secret values are hidden after creation.</p></div></div>
              {keys.length ? keys.map((key) => <div className="system-row" key={key.id}>
                <div><strong>{key.name}</strong><div className="pm-card-description">{key.key_prefix}… · {(key.scopes || []).join(", ")} · Created {new Date(key.created_at).toLocaleDateString()}</div><div className="pm-card-description">Last used: {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "Never"} · Expires: {key.expires_at ? new Date(key.expires_at).toLocaleDateString() : "Never"}</div>{key.revoked_at && <div className="pm-card-description">Revoked {new Date(key.revoked_at).toLocaleString()}</div>}</div>
                {!key.revoked_at && <button className="pm-archive-button" type="button" onClick={() => void revokeKey(key)}>Revoke</button>}
              </div>) : <div className="pm-empty"><h3>No secret keys yet</h3><p>Create a secret key above to let your private website backend connect to this database.</p></div>}
            </article>
          </> : <div className="pm-empty panel"><h2>Select an active database resource</h2><p>Create a database resource in Projects before generating an API key.</p></div>}
        </>
      )}
    </section>
  );
}
