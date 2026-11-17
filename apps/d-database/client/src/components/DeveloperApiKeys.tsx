import { useEffect, useMemo, useState } from "react";

type Project = { id: string; name: string };
type Resource = { id: string; name: string; status: string };
type ApiKey = {
  id: string; name: string; key_prefix: string; scopes: string[];
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
};
type ApiResponse = { success?: boolean; message?: string; projects?: Project[]; resources?: Resource[]; keys?: ApiKey[]; key?: ApiKey; secret?: string };

export default function DeveloperApiKeys({ onBackToDashboard, onOpenProjects }: { onBackToDashboard: () => void; onOpenProjects: () => void }) {
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

  const activeKeys = keys.filter((key) => !key.revoked_at && (!key.expires_at || new Date(key.expires_at).getTime() > Date.now()));
  const revokedKeys = keys.filter((key) => Boolean(key.revoked_at));
  const expiredKeys = keys.filter((key) => !key.revoked_at && Boolean(key.expires_at) && new Date(key.expires_at!).getTime() <= Date.now());
  const apiOrigin = window.location.origin;

  return (
    <section className="pm-page api-page">
      <div className="api-page-header">
        <div className="api-page-heading">
          <div className="welcome-date">DEVELOPER TOOLS / SECURITY</div>
          <h1>API Keys</h1>
          <p>Manage secure credentials for applications that need to access your D Database resources.</p>
          <div className="api-header-badges"><span className="api-badge api-badge-live">● API management available</span><span className="api-badge">Scoped per database</span></div>
        </div>
        <div className="api-header-actions">
          <button className="ui-button ui-button-secondary" type="button" onClick={onBackToDashboard}>← Back to dashboard</button>
          <button className="ui-button ui-button-primary" type="button" onClick={onOpenProjects}>Open projects</button>
        </div>
      </div>

      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <div className="api-notice" role="status"><span>✓</span>{notice}</div>}

      <div className="api-stats-grid">
        <article className="api-stat-card"><span className="api-stat-icon">⌘</span><div><small>Total keys</small><strong>{keys.length}</strong><span>Created for this database</span></div></article>
        <article className="api-stat-card"><span className="api-stat-icon api-stat-green">✓</span><div><small>Active keys</small><strong>{activeKeys.length}</strong><span>Currently valid credentials</span></div></article>
        <article className="api-stat-card"><span className="api-stat-icon api-stat-orange">◷</span><div><small>Expired or revoked</small><strong>{expiredKeys.length + revokedKeys.length}</strong><span>No longer able to authenticate</span></div></article>
      </div>

      <article className="api-security-banner">
        <span className="api-security-icon">!</span>
        <div><strong>Keep secret keys on your server</strong><p>Never place a secret key in browser JavaScript, a public repository, screenshots, or a mobile app bundle. If a key is exposed, revoke it and create a replacement.</p></div>
      </article>

      {loading ? <div className="pm-empty panel"><div className="pm-spinner" /><strong>Loading your API settings...</strong></div> : (
        <>
          <article className="panel api-panel">
            <div className="api-section-heading"><div><span className="api-step">01</span><div><h2>Choose a database</h2><p>API keys are restricted to one project and one database resource.</p></div></div></div>
            <div className="api-select-grid">
              <label>Project
                <select id="developer-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                  {projects.length ? projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No projects available</option>}
                </select>
              </label>
              <label>Active database
                <select id="developer-resource" value={resourceId} onChange={(event) => setResourceId(event.target.value)} disabled={!resources.length}>
                  {resources.length ? resources.map((item) => <option value={item.id} key={item.id}>{item.name}</option>) : <option value="">No active databases in this project</option>}
                </select>
              </label>
            </div>
            {!projects.length && <div className="api-empty-inline"><strong>No projects yet</strong><span>Create a project and a database before generating an API key.</span><button className="ui-button ui-button-primary" type="button" onClick={onOpenProjects}>Create a project</button></div>}
            {projects.length > 0 && !resources.length && <div className="api-empty-inline"><strong>No active database in this project</strong><span>Create or activate a database resource to continue.</span><button className="ui-button ui-button-secondary" type="button" onClick={onOpenProjects}>Manage databases</button></div>}
          </article>

          {resourceId ? <>
            <article className="panel api-panel">
              <div className="api-section-heading"><div><span className="api-step">02</span><div><h2>Connect your application</h2><p>Use these values in your private backend environment.</p></div></div><button className="ui-button ui-button-secondary ui-button-small" type="button" onClick={() => void navigator.clipboard.writeText(apiOrigin).then(() => setNotice("API address copied."), () => setError("Could not copy the API address."))}>Copy API address</button></div>
              <div className="api-endpoint-row"><div><small>API base address</small><code>{apiOrigin}/api/v1</code></div><span className="api-endpoint-status">HTTPS / same origin</span></div>
              <div className="api-code-heading"><strong>Environment variables</strong><span>Keep this file private. Do not commit real secrets.</span></div>
              <pre className="api-code-block"><code>{`D_DATABASE_URL=${apiOrigin}\nD_DATABASE_PROJECT_ID=${projectId}\nD_DATABASE_RESOURCE_ID=${resourceId}\nD_DATABASE_API_KEY=dsq_live_replace_with_your_secret`}</code></pre>
              <div className="api-code-heading"><strong>Node.js example</strong><span>Use the official D Database SDK in your server.</span></div>
              <pre className="api-code-block"><code>{`import { createDDatabaseClient } from "@dsquare/d-database";\n\nconst db = createDDatabaseClient({\n  baseUrl: process.env.D_DATABASE_URL,\n  apiKey: process.env.D_DATABASE_API_KEY,\n  projectId: process.env.D_DATABASE_PROJECT_ID,\n  resourceId: process.env.D_DATABASE_RESOURCE_ID,\n});\n\nconst tables = await db.listTables();\nconst rows = await db.select("your_table", { limit: 25, offset: 0 });`}</code></pre>
              <p className="api-help-note">The project ID and database ID are identifiers, not secrets. The API key is a secret and must only be sent from a trusted server.</p>
            </article>

            <article className="panel api-panel">
              <div className="api-section-heading"><div><span className="api-step">03</span><div><h2>Create a secret key</h2><p>Give each application its own key and only the permissions it needs.</p></div></div></div>
              <form className="api-create-form" onSubmit={createKey}>
                <label className="api-field api-field-wide">Key name<input id="developer-key-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="e.g. Production website" required /></label>
                <div className="api-permission-box"><strong>Permissions</strong><p>Choose what this key can do.</p><div className="api-permissions">
                  <label className="api-permission-option"><input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} /><span><strong>Read records</strong><small>View database tables and records.</small></span></label>
                  <label className="api-permission-option"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} /><span><strong>Write records</strong><small>Create, update, and delete records.</small></span></label>
                </div></div>
                <label className="api-field">Key expiry<select id="developer-key-expiry" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option><option value="">Never (not recommended)</option></select></label>
                <div className="api-form-actions"><span>Use separate keys for development and production.</span><button className="ui-button ui-button-primary" type="submit" disabled={saving || !projectId || !resourceId || (!read && !write)}>{saving ? "Creating key..." : "＋ Create API key"}</button></div>
              </form>
            </article>

            {secret && <article className="api-secret-panel">
              <div className="api-secret-heading"><span>✓</span><div><h2>Your new secret key</h2><p>Copy it now. The full secret is only shown once.</p></div></div>
              <textarea readOnly value={secret} rows={2} aria-label="New API secret" />
              <div className="api-form-actions"><span>Store it in your server's secret manager or environment.</span><div><button className="ui-button ui-button-secondary" type="button" onClick={() => void copySecret()}>Copy secret</button><button className="ui-button ui-button-primary" type="button" onClick={() => setSecret("")}>I've saved it</button></div></div>
            </article>}

            <article className="panel api-panel">
              <div className="api-section-heading"><div><span className="api-step">04</span><div><h2>Key inventory</h2><p>Review key permissions, activity, expiry, and status for this database.</p></div></div><span className="api-inventory-count">{keys.length} total</span></div>
              {keys.length ? <div className="api-key-list">{keys.map((key) => {
                const isExpired = Boolean(key.expires_at) && new Date(key.expires_at!).getTime() <= Date.now();
                const status = key.revoked_at ? "Revoked" : isExpired ? "Expired" : "Active";
                return <div className="api-key-row" key={key.id}>
                  <div className="api-key-main"><span className="api-key-icon">⌘</span><div><strong>{key.name}</strong><code>{key.key_prefix}••••••••</code><div className="api-key-meta"><span>{(key.scopes || []).join(" + ") || "No permissions"}</span><span>Created {new Date(key.created_at).toLocaleDateString()}</span><span>Last used {key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : "Never"}</span><span>Expires {key.expires_at ? new Date(key.expires_at).toLocaleDateString() : "Never"}</span></div></div></div>
                  <div className="api-key-actions"><span className={`api-key-status ${status.toLowerCase()}`}>{status}</span>{!key.revoked_at && !isExpired && <button className="ui-button ui-button-danger ui-button-small" type="button" onClick={() => void revokeKey(key)}>Revoke key</button>}</div>
                </div>;
              })}</div> : <div className="api-empty-state"><span>⌘</span><strong>No API keys for this database yet</strong><p>Create a key above to connect your backend securely. You can revoke it at any time.</p></div>}
            </article>
          </> : <div className="api-empty-state panel"><span>◈</span><strong>Select an active database to continue</strong><p>Choose a project with an active PostgreSQL database resource. You can manage resources from Projects.</p><button className="ui-button ui-button-secondary" type="button" onClick={onOpenProjects}>Open projects</button></div>}
        </>
      )}
    </section>
  );
}}
