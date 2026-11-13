import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

type EnvironmentVariable = {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
};

type Props = { resourceUrl: string; siteType?: "static" | "node" };

export default function EnvironmentVariables({ resourceUrl, siteType }: Props) {
  const [variables, setVariables] = useState<EnvironmentVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadVariables = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${resourceUrl}/environment`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load environment variables.");
      setVariables(Array.isArray(data.variables) ? data.variables : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load environment variables.");
    } finally {
      setLoading(false);
    }
  }, [resourceUrl]);

  useEffect(() => { void loadVariables(); }, [loadVariables]);

  function resetForm() {
    setName("");
    setValue("");
    setEditingName(null);
    setShowValue(false);
  }

  async function saveVariable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/environment`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not save environment variable.");
      setNotice(editingName ? "Environment variable updated." : "Environment variable saved.");
      resetForm();
      await loadVariables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save environment variable.");
    } finally {
      setSaving(false);
    }
  }

  async function removeVariable(variableName: string) {
    if (!window.confirm(`Delete the ${variableName} environment variable? This cannot be undone.`)) return;
    setDeleting(variableName);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/environment/${encodeURIComponent(variableName)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not delete environment variable.");
      setVariables((current) => current.filter((item) => item.name !== variableName));
      if (editingName === variableName) resetForm();
      setNotice("Environment variable deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete environment variable.");
    } finally {
      setDeleting(null);
    }
  }

  function beginEdit(variableName: string) {
    setEditingName(variableName);
    setName(variableName);
    setValue("");
    setShowValue(false);
    setError("");
    setNotice("Enter the new value to replace the saved secret. The existing value cannot be viewed.");
  }

  return (
    <article className="panel wb-panel" style={{ marginBottom: 20 }}>
      <div className="panel-heading">
        <div>
          <h2>Environment variables</h2>
          <p>Store configuration and secrets securely for this website.</p>
        </div>
        <span className="wb-count">{variables.length} variables</span>
      </div>

      <div className="pm-resource-notice" role="note">
        Values are encrypted at rest and never shown again after saving. For Node.js websites, saved values are prepared for private runtime injection, but customer code execution remains disabled until the dedicated Linux isolation and operator acceptance gates are completed.
      </div>

      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <div className="pm-resource-notice" role="status">{notice}</div>}

      <form onSubmit={saveVariable} style={{ display: "grid", gap: 12, margin: "18px 0" }}>
        <strong>{editingName ? `Update ${editingName}` : "Add a variable"}</strong>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Variable name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. DATABASE_URL"
            autoComplete="off"
            maxLength={128}
            required
            disabled={saving || Boolean(editingName)}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Value</span>
          <input
            type={showValue ? "text" : "password"}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={editingName ? "Enter replacement value" : "Enter secret or configuration value"}
            autoComplete="new-password"
            maxLength={16384}
            required
            disabled={saving}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={showValue} onChange={(event) => setShowValue(event.target.checked)} />
          Show value while typing
        </label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="primary-button" type="submit" disabled={saving || !name.trim() || !value}>
            {saving ? "Saving..." : editingName ? "Save changes" : "Add variable"}
          </button>
          {editingName && <button className="secondary-button" type="button" onClick={resetForm} disabled={saving}>Cancel edit</button>}
        </div>
      </form>

      <div style={{ borderTop: "1px solid var(--border-color, #ddd)", paddingTop: 14 }}>
        <h3>Saved variables</h3>
        {loading ? (
          <p>Loading environment variables...</p>
        ) : variables.length === 0 ? (
          <p>No environment variables have been added yet.</p>
        ) : (
          <div className="wb-file-list">
            {variables.map((variable) => (
              <div className="wb-file-row" key={variable.name}>
                <div className="wb-file-info">
                  <strong>{variable.name}</strong>
                  <small>Secret value stored securely ·••••••••</small>
                </div>
                <div className="wb-file-actions">
                  <button type="button" onClick={() => beginEdit(variable.name)} disabled={saving || deleting !== null}>Edit</button>
                  <button type="button" className="danger" onClick={() => void removeVariable(variable.name)} disabled={deleting !== null || saving}>
                    {deleting === variable.name ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && error && <button type="button" className="secondary-button" onClick={() => void loadVariables()}>Retry loading</button>}
      </div>
      {siteType === "node" && <p style={{ marginTop: 14, fontSize: 13 }}>Node.js backend execution is not enabled yet.</p>}
    </article>
  );
}
