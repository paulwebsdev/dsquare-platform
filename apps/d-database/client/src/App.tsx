import { useEffect, useState } from "react";
import "./style.css";
import ProjectManager from "./components/ProjectManager";

type Theme = "light" | "dark" | "system";

type ProjectSummary = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at: string;
};

const navigation = [
  { label: "Overview", icon: "◫" },
  { label: "Projects", icon: "▦" },
  { label: "Resources", icon: "◈" },
  { label: "Usage & Billing", icon: "▤" },
  { label: "Activity", icon: "◷" },
  { label: "Settings", icon: "⚙" }
];

export default function App() {
  const product = import.meta.env.VITE_PRODUCT_NAME || "DSquare";
  const resource = import.meta.env.VITE_RESOURCE_LABEL || "Resources";
  const tagline = import.meta.env.VITE_PRODUCT_TAGLINE || "Manage your infrastructure.";

  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("dsquare-theme");
    return saved === "light" || saved === "dark" || saved === "system"
      ? saved
      : "system";
  });

  const [activePage, setActivePage] = useState("Overview");
  const [apiStatus, setApiStatus] = useState("Checking connection...");
  const [projectCount, setProjectCount] = useState(0);
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);

  const refreshProjectSummary = async () => {
    try {
      const response = await fetch("/api/v1/projects");
      if (!response.ok) throw new Error("Could not load projects.");

      const data = await response.json() as {
        count?: number;
        projects: ProjectSummary[];
      };

      setProjectCount(data.count ?? data.projects.length);
      setRecentProjects(data.projects.slice(0, 3));
    } catch (error) {
      console.error("Could not refresh project summary:", error);
    }
  };

  useEffect(() => {
    const applyTheme = () => {
      const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const actualTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = actualTheme;
    };

    applyTheme();
    localStorage.setItem("dsquare-theme", theme);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    fetch("/api/v1/health")
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        return response.json();
      })
      .then((data) => setApiStatus(data.database?.connected ? "Database connected" : data.api || data.message || "API online"))
      .catch(() => setApiStatus("API connection unavailable"));
  }, []);

  useEffect(() => {
    void refreshProjectSummary();
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#">
          <span className="brand-mark">D</span>
          <span>DSQUARE<span className="brand-dot">.</span></span>
        </a>

        <div className="workspace-label">WORKSPACE</div>
        <div className="workspace-switch">
          <span className="workspace-icon">{product.charAt(0)}</span>
          <span className="workspace-name">{product}</span>
          <span className="workspace-arrow">⌄</span>
        </div>

        <div className="nav-label">MENU</div>
        <nav className="navigation">
          {navigation.map((item) => (
            <button
              key={item.label}
              className={`nav-item ${activePage === item.label ? "active" : ""}`}
              onClick={() => setActivePage(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.label === "Projects" && <span className="nav-count">{projectCount}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">?</div>
            <strong>Need some help?</strong>
            <p>Visit our documentation to learn more.</p>
            <button onClick={() => setActivePage("Help & Support")}>Get help <span>→</span></button>
          </div>
          <div className="profile">
            <div className="avatar">P</div>
            <div className="profile-info">
              <strong>My Account</strong>
              <span>DSquare user</span>
            </div>
            <span className="profile-menu">•••</span>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span><span className="crumb-separator">/</span>
            <strong>{activePage}</strong>
          </div>
          <div className="topbar-actions">
            <div className="connection"><span className="connection-dot"></span> {apiStatus}</div>
            <button className="icon-button" title="Notifications">♧</button>
            <div className="theme-control" aria-label="Theme selection">
              <button className={theme === "light" ? "selected" : ""} onClick={() => setTheme("light")} title="Light mode">☀</button>
              <button className={theme === "dark" ? "selected" : ""} onClick={() => setTheme("dark")} title="Dark mode">☾</button>
              <button className={theme === "system" ? "selected" : ""} onClick={() => setTheme("system")} title="System theme">◐</button>
            </div>
          </div>
        </header>

        <div className="content">
          {activePage === "Projects" ? (
            <ProjectManager onProjectsChange={refreshProjectSummary} />
          ) : (
            <>
          <section className="welcome-row">
            <div>
              <div className="welcome-date">YOUR WORKSPACE</div>
              <h1>{activePage === "Overview" ? "Welcome to " + product : activePage}</h1>
              <p>{activePage === "Overview" ? tagline : "Manage and monitor your " + product + " workspace."}</p>
            </div>
            <button className="primary-button" onClick={() => setActivePage("Projects")}>
              <span>＋</span> Create new project
            </button>
          </section>

          <section className="stats-grid">
            <article className="stat-card">
              <div className="stat-heading"><span>Total projects</span><span className="stat-icon purple">▦</span></div>
              <div className="stat-value">{projectCount}</div>
              <div className="stat-foot">{projectCount === 0 ? "No projects created yet" : "Active workspace projects"}</div>
            </article>
            <article className="stat-card">
              <div className="stat-heading"><span>{resource}</span><span className="stat-icon blue">◈</span></div>
              <div className="stat-value">0</div>
              <div className="stat-foot">Nothing running yet</div>
            </article>
            <article className="stat-card">
              <div className="stat-heading"><span>Storage used</span><span className="stat-icon orange">▤</span></div>
              <div className="stat-value">0 <small>MB</small></div>
              <div className="stat-foot">Your storage overview</div>
            </article>
            <article className="stat-card">
              <div className="stat-heading"><span>Workspace status</span><span className="stat-icon green">✓</span></div>
              <div className="stat-value status-value">Ready</div>
              <div className="stat-foot">Your workspace is available</div>
            </article>
          </section>

          <section className="main-grid">
            <article className="panel projects-panel">
              <div className="panel-heading">
                <div><h2>Recent projects</h2><p>Your latest workspace projects</p></div>
                <button className="text-button" onClick={() => setActivePage("Projects")}>View all →</button>
              </div>
              {recentProjects.length > 0 ? (
                <div className="recent-projects">
                  {recentProjects.map((project) => (
                    <button
                      className="recent-project-item"
                      key={project.id}
                      onClick={() => setActivePage("Projects")}
                    >
                      <span className="recent-project-icon">
                        {project.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="recent-project-info">
                        <strong>{project.name}</strong>
                        <small>{project.description || "No description added."}</small>
                      </span>
                      <span className="recent-project-arrow">→</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <div className="empty-illustration"><span>▦</span><i>＋</i></div>
                  <h3>Your workspace is ready</h3>
                  <p>Create your first project to get started with {product}.</p>
                  <button className="secondary-button" onClick={() => setActivePage("Projects")}>＋ Create a project</button>
                </div>
              )}
            </article>

            <article className="panel activity-panel">
              <div className="panel-heading">
                <div><h2>Recent activity</h2><p>Updates from your workspace</p></div>
                <span className="activity-menu">•••</span>
              </div>
              <div className="activity-empty">
                <span className="activity-clock">◷</span>
                <strong>No activity yet</strong>
                <p>Your recent actions will appear here.</p>
              </div>
            </article>
          </section>

          <section className="bottom-grid">
            <article className="panel quick-panel">
              <div className="panel-heading"><div><h2>Quick access</h2><p>Common workspace actions</p></div></div>
              <div className="quick-actions">
                <button onClick={() => setActivePage("Projects")}><span>＋</span><div><strong>New project</strong><small>Start something new</small></div><b>→</b></button>
                <button onClick={() => setActivePage("Resources")}><span>◈</span><div><strong>Explore {resource.toLowerCase()}</strong><small>View available resources</small></div><b>→</b></button>
                <button onClick={() => setActivePage("Settings")}><span>⚙</span><div><strong>Workspace settings</strong><small>Configure your workspace</small></div><b>→</b></button>
              </div>
            </article>
            <article className="panel system-panel">
              <div className="panel-heading"><div><h2>System information</h2><p>Product connection status</p></div></div>
              <div className="system-row"><span>Product</span><strong>{product}</strong></div>
              <div className="system-row"><span>API connection</span><strong className="system-online"><i></i>{apiStatus}</strong></div>
              <div className="system-row"><span>Environment</span><strong>Local development</strong></div>
              <div className="system-row"><span>Version</span><strong>0.1.0</strong></div>
            </article>
          </section>

          <footer className="footer">
            <span>© 2026 DSquare Platform</span>
            <span>Built for your next big idea.</span>
          </footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
