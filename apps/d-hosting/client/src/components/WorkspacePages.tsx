import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";
type User = { email: string };
type Project = { id: string; name: string };
type Resource = {
  id: string;
  name: string;
  status: string;
  updated_at?: string;
  created_at?: string;
  site_type?: string;
  engine?: string;
};
type ResourceEntry = { project: Project; resource: Resource };
type ProjectList = { projects?: Project[]; message?: string };
type ResourceList = { resources?: Resource[]; message?: string };

export function ResourceDirectory({ onOpenProjects }: { onOpenProjects: () => void }) {
  const [entries, setEntries] = useState<ResourceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/v1/projects", { credentials: "same-origin" });
        const data = await response.json() as ProjectList;
        if (!response.ok) throw new Error(data.message || "Could not load projects.");
        const projects = data.projects || [];
        const lists = await Promise.all(projects.map(async (project) => {
          const result = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/resources`, { credentials: "same-origin" });
          const body = await result.json() as ResourceList;
          if (!result.ok) throw new Error(body.message || `Could not load resources for ${project.name}.`);
          return (body.resources || []).map((resource) => ({ project, resource }));
        }));
        if (active) setEntries(lists.flat());
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load resources.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  const term = search.trim().toLowerCase();
  const visible = entries.filter(({ project, resource }) =>
    !term || resource.name.toLowerCase().includes(term) || project.name.toLowerCase().includes(term)
  );

  return (
    <section className="pm-page">
      <div className="pm-heading">
        <div><div className="welcome-date">WORKSPACE MANAGEMENT</div><h1>Resources</h1><p>All websites and databases across your active projects.</p></div>
        <button className="primary-button" onClick={onOpenProjects}>Manage projects</button>
      </div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      <div className="pm-toolbar">
        <span className="pm-tabs"><strong>{entries.length} resource{entries.length === 1 ? "" : "s"}</strong></span>
        <input className="pm-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search resources or projects..." aria-label="Search resources" />
      </div>
      {loading ? <div className="pm-empty panel"><div className="pm-spinner" /><strong>Loading resources...</strong></div>
        : visible.length ? <div className="pm-project-grid">{visible.map(({ project, resource }) => (
          <article className="pm-project-card panel" key={resource.id}>
            <div className="pm-card-top"><div className="pm-project-avatar">{resource.name.charAt(0).toUpperCase()}</div><span className={`pm-status ${resource.status}`}>{resource.status}</span></div>
            <h3>{resource.name}</h3>
            <p className="pm-card-description">{project.name} · {resource.site_type === "node" ? "Node.js website" : resource.engine || resource.site_type || "Resource"}</p>
            <div className="pm-card-footer"><span>Updated {resource.updated_at ? new Date(resource.updated_at).toLocaleDateString() : "—"}</span><button onClick={onOpenProjects}>Open project →</button></div>
          </article>
        ))}</div> : <div className="pm-empty panel"><div className="pm-empty-icon">◈</div><h2>{search ? "No matching resources" : "No resources yet"}</h2><p>{search ? "Try another search term." : "Create a website or database inside one of your projects to see it here."}</p><button className="primary-button" onClick={onOpenProjects}>Go to projects</button></div>}
    </section>
  );
}

export function WorkspaceSettings({ product, user, theme, onThemeChange, onSignOut }: {
  product: string; user: User; theme: Theme; onThemeChange: (theme: Theme) => void; onSignOut: () => void;
}) {
  return (
    <section className="pm-page">
      <div className="pm-heading"><div><div className="welcome-date">WORKSPACE PREFERENCES</div><h1>Settings</h1><p>Manage your account display and workspace preferences.</p></div></div>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Appearance</h2><p>Choose how {product} looks on this device. Your choice is saved automatically.</p></div></div>
        <label htmlFor="workspace-theme">Theme</label>
        <select id="workspace-theme" value={theme} onChange={(event) => onThemeChange(event.target.value as Theme)}>
          <option value="system">Use system preference</option><option value="light">Light</option><option value="dark">Dark</option>
        </select>
      </article>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Account</h2><p>Signed-in account for this workspace.</p></div></div>
        <div className="pm-detail-meta"><div><span>Product</span><strong>{product}</strong></div><div><span>Email</span><strong>{user.email}</strong></div><div><span>Session</span><strong>Active</strong></div></div>
        <div className="pm-detail-actions"><button className="pm-archive-button" onClick={onSignOut}>Sign out</button></div>
      </article>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Workspace security</h2><p>Your account is protected by the current sign-in session. Password and email changes are not exposed here until a secure account-management flow is available.</p></div></div>
      </article>
    </section>
  );
}
