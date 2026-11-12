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
            <div className="pm-card-footer"><span>Updated {resource.updated_at ? new Date(resource.updated_at).toLocaleDateString() : "—"}</span><button onClick={onOpenProjects}>Manage projects →</button></div>
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

export function WorkspaceActivity({ onOpenProjects }: { onOpenProjects: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; title: string; detail: string; at: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/v1/projects", { credentials: "same-origin" });
        const data = await response.json() as { projects?: Array<{ id: string; name: string; created_at: string; updated_at: string }> ; message?: string };
        if (!response.ok) throw new Error(data.message || "Could not load activity.");
        const projects = data.projects || [];
        const groups = await Promise.all(projects.map(async (project) => {
          const result = await fetch("/api/v1/projects/" + encodeURIComponent(project.id) + "/resources", { credentials: "same-origin" });
          const body = await result.json() as { resources?: Array<{ id: string; name: string; created_at: string; updated_at: string }>; message?: string };
          if (!result.ok) throw new Error(body.message || "Could not load resource activity.");
          const events = [{ id: "project-created-" + project.id, title: "Project created", detail: project.name, at: project.created_at }];
          if (new Date(project.updated_at).getTime() > new Date(project.created_at).getTime() + 1000) {
            events.push({ id: "project-updated-" + project.id, title: "Project last updated", detail: project.name, at: project.updated_at });
          }
          for (const resource of body.resources || []) {
            events.push({ id: "resource-created-" + resource.id, title: "Resource created", detail: resource.name + " · " + project.name, at: resource.created_at });
            if (new Date(resource.updated_at).getTime() > new Date(resource.created_at).getTime() + 1000) {
              events.push({ id: "resource-updated-" + resource.id, title: "Resource last updated", detail: resource.name + " · " + project.name, at: resource.updated_at });
            }
          }
          return events;
        }));
        if (active) setItems(groups.flat().filter((item) => Number.isFinite(new Date(item.at).getTime())).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 50));
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load activity.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  return (
    <section className="pm-page">
      <div className="pm-heading"><div><div className="welcome-date">WORKSPACE HISTORY</div><h1>Activity</h1><p>Recent project and resource creation and last-update timestamps.</p></div><button className="secondary-button" onClick={onOpenProjects}>View projects</button></div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      {loading ? <div className="pm-empty panel"><div className="pm-spinner" /><strong>Loading activity...</strong></div>
        : items.length ? <div className="panel">{items.map((item) => (
          <div className="system-row" key={item.id}><div><strong>{item.title}</strong><div className="pm-card-description">{item.detail}</div></div><span>{new Date(item.at).toLocaleString()}</span></div>
        ))}</div>
        : <div className="pm-empty panel"><div className="pm-empty-icon">◷</div><h2>No activity recorded yet</h2><p>Project and resource creation or updates will appear here.</p><button className="primary-button" onClick={onOpenProjects}>Go to projects</button></div>}
      <p className="pm-card-description">This view uses saved creation and last-update timestamps. It is not a complete audit log of every action.</p>
    </section>
  );
}


export function UsageBilling({ product, onOpenProjects }: { product: string; onOpenProjects: () => void }) {
  const [projectCount, setProjectCount] = useState<number | null>(null);
  const [resourceCount, setResourceCount] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch("/api/v1/projects", { credentials: "same-origin" });
        const data = await response.json() as { projects?: Project[]; message?: string };
        if (!response.ok) throw new Error(data.message || "Could not load workspace usage.");
        const projects = data.projects || [];
        const resources = await Promise.all(projects.map(async (project) => {
          const result = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/resources`, { credentials: "same-origin" });
          const body = await result.json() as { resources?: Resource[]; message?: string };
          if (!result.ok) throw new Error(body.message || "Could not load resource usage.");
          return body.resources || [];
        }));
        if (active) {
          setProjectCount(projects.length);
          setResourceCount(resources.reduce((total, list) => total + list.length, 0));
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load workspace usage.");
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  return (
    <section className="pm-page">
      <div className="pm-heading"><div><div className="welcome-date">WORKSPACE PLAN</div><h1>Usage &amp; Billing</h1><p>Current workspace counts and billing availability for {product}.</p></div></div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      <div className="stats-grid">
        <article className="stat-card"><div className="stat-heading"><span>Projects</span></div><div className="stat-value">{projectCount === null ? "—" : projectCount}</div><div className="stat-foot">Projects currently returned by your workspace</div></article>
        <article className="stat-card"><div className="stat-heading"><span>Resources</span></div><div className="stat-value">{resourceCount === null ? "—" : resourceCount}</div><div className="stat-foot">Websites and databases in active projects</div></article>
      </div>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Billing is not enabled yet</h2><p>Online payments, invoices, subscription changes, and metered storage or compute billing are not connected in this workspace. No charge or plan amount is being estimated here.</p></div></div>
        <div className="pm-detail-actions"><button className="primary-button" onClick={onOpenProjects}>Manage projects</button></div>
      </article>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Usage data</h2><p>Project and resource counts are loaded from your workspace API. Storage, bandwidth, runtime hours, and database usage are not yet measured on this page.</p></div></div>
      </article>
    </section>
  );
}

export function HelpSupport({ product, onNavigate }: { product: string; onNavigate: (page: string) => void }) {
  const links = [
    { title: "Projects", detail: "Create, rename, archive, and restore workspace projects." },
    { title: "Resources", detail: "Review the websites and databases inside your projects." },
    { title: "Activity", detail: "Check saved project and resource creation or update timestamps." },
    { title: "Settings", detail: "Change the appearance or sign out of this workspace." }
  ];
  return (
    <section className="pm-page">
      <div className="pm-heading"><div><div className="welcome-date">HELP CENTRE</div><h1>Help &amp; Support</h1><p>Quick guidance for using {product}.</p></div></div>
      <div className="pm-project-grid">
        {links.map((link) => (
          <article className="pm-project-card panel" key={link.title}>
            <h3>{link.title}</h3><p className="pm-card-description">{link.detail}</p>
            <div className="pm-card-footer"><span>Workspace guide</span><button onClick={() => onNavigate(link.title)}>Open →</button></div>
          </article>
        ))}
      </div>
      <article className="pm-detail panel">
        <div className="pm-form-heading"><div><h2>Contact support</h2><p>A support inbox or ticket service has not been configured in this environment yet. Please do not enter passwords, API keys, database credentials, or other secrets into support messages.</p></div></div>
      </article>
    </section>
  );
}
