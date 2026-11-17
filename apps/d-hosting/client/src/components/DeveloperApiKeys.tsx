type Props = {
  apiStatus: string;
  onBackToDashboard: () => void;
  onOpenConnections: () => void;
  onOpenProjects: () => void;
};

export default function DeveloperApiKeys({ apiStatus, onBackToDashboard, onOpenConnections, onOpenProjects }: Props) {
  const apiOrigin = window.location.origin;
  const endpoints = [
    { method: "GET", path: "/projects", description: "List projects in your signed-in workspace." },
    { method: "GET", path: "/projects/:projectId/resources", description: "List websites and hosting resources for a project." },
    { method: "POST", path: "/projects", description: "Create a project in your workspace." },
  ];

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard access can be blocked by browser permissions; the value remains selectable.
    }
  }

  return (
    <section className="pm-page api-page">
      <div className="api-page-header">
        <div className="api-page-heading">
          <div className="welcome-date">DEVELOPER TOOLS / API ACCESS</div>
          <h1>API &amp; Integrations</h1>
          <p>Understand how applications communicate with D Hosting and connect your websites to other DSquare services.</p>
          <div className="api-header-badges"><span className="api-badge api-badge-live">● {apiStatus}</span><span className="api-badge">Workspace protected</span></div>
        </div>
        <div className="api-header-actions">
          <button className="ui-button ui-button-secondary" type="button" onClick={onBackToDashboard}>← Back to dashboard</button>
          <button className="ui-button ui-button-primary" type="button" onClick={onOpenConnections}>Database connections</button>
        </div>
      </div>

      <article className="api-security-banner">
        <span className="api-security-icon">i</span>
        <div><strong>How API access works today</strong><p>D Hosting dashboard API requests use your signed-in, secure workspace session. Dedicated personal API keys are not yet available for D Hosting, so this page does not generate fake or non-working keys.</p></div>
      </article>

      <div className="api-stats-grid api-hosting-stats">
        <article className="api-stat-card"><span className="api-stat-icon">↗</span><div><small>API base address</small><strong className="api-stat-url">{apiOrigin}/api/v1</strong><span>Same-origin HTTPS endpoint</span></div></article>
        <article className="api-stat-card"><span className="api-stat-icon api-stat-green">✓</span><div><small>Authentication</small><strong>Workspace session</strong><span>Signed-in dashboard requests</span></div></article>
        <article className="api-stat-card"><span className="api-stat-icon api-stat-orange">⌘</span><div><small>Personal API keys</small><strong>Not available yet</strong><span>Key issuance is not enabled in Hosting</span></div></article>
      </div>

      <article className="panel api-panel">
        <div className="api-section-heading"><div><span className="api-step">01</span><div><h2>API endpoint</h2><p>Use the API base address when exploring the D Hosting workspace API.</p></div></div><button className="ui-button ui-button-secondary ui-button-small" type="button" onClick={() => void copy(apiOrigin + "/api/v1")}>Copy address</button></div>
        <div className="api-endpoint-row"><div><small>Base address</small><code>{apiOrigin}/api/v1</code></div><span className="api-endpoint-status">HTTPS</span></div>
        <p className="api-help-note">The API origin follows the dashboard domain. Requests from the signed-in dashboard include the secure session cookie automatically.</p>
      </article>

      <article className="panel api-panel">
        <div className="api-section-heading"><div><span className="api-step">02</span><div><h2>Available workspace endpoints</h2><p>Examples of the dashboard API routes currently used by D Hosting.</p></div></div></div>
        <div className="api-endpoint-list">{endpoints.map((item) => <div className="api-endpoint-item" key={item.method + item.path}><span className={`api-method api-method-${item.method.toLowerCase()}`}>{item.method}</span><code>/api/v1{item.path}</code><p>{item.description}</p></div>)}</div>
        <div className="api-code-heading"><strong>Authenticated request example</strong><span>For use within the signed-in dashboard session.</span></div>
        <pre className="api-code-block"><code>{`const response = await fetch("/api/v1/projects", {\n  credentials: "same-origin",\n});\n\nif (!response.ok) {\n  throw new Error("Could not load projects");\n}\n\nconst data = await response.json();`}</code></pre>
      </article>

      <article className="panel api-panel">
        <div className="api-section-heading"><div><span className="api-step">03</span><div><h2>Connect D Database</h2><p>Use the built-in integration flow to connect a website to a database resource.</p></div></div></div>
        <div className="api-integration-card"><span className="api-integration-icon">⇄</span><div><strong>DSquare database connection</strong><p>Authorize D Hosting to use a selected D Database resource. Connection credentials are managed by the integration flow, not pasted into frontend code.</p></div><button className="ui-button ui-button-primary" type="button" onClick={onOpenConnections}>Manage connections</button></div>
      </article>

      <article className="api-panel api-roadmap-panel">
        <div className="api-roadmap-icon">⌘</div><div><strong>Dedicated D Hosting API keys</strong><p>Personal, scoped API keys for external automation and server-to-server access are a separate capability. They will appear here when key issuance, permissions, rotation, and revocation are supported by the Hosting API.</p></div>
        <span className="api-roadmap-status">Planned</span>
      </article>

      <div className="api-footer-actions"><button className="ui-button ui-button-secondary" type="button" onClick={onBackToDashboard}>← Return to dashboard</button><button className="ui-button ui-button-primary" type="button" onClick={onOpenProjects}>Manage projects</button></div>
    </section>
  );
}
