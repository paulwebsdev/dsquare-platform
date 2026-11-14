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
      if (!response.ok) throw new Error(data.message || "Could not load website settings.");
      setVariables(Array.isArray(data.variables) ? data.variables : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load website settings.");
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
      if (!response.ok) throw new Error(data.message || "Could not save this website setting.");
      setNotice(editingName ? "Website setting updated." : "Website setting saved.");
      resetForm();
      await loadVariables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this website setting.");
    } finally {
      setSaving(false);
    }
  }

  async function removeVariable(variableName: string) {
    if (!window.confirm(`Delete the "${variableName}" setting? This action cannot be undone.`)) return;
    setDeleting(variableName);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/environment/${encodeURIComponent(variableName)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not delete this website setting.");
      setVariables((current) => current.filter((item) => item.name !== variableName));
      if (editingName === variableName) resetForm();
      setNotice("Website setting deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this website setting.");
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
    setNotice("Enter a replacement value below. For security, the existing value cannot be viewed.");
  }

  return (
    <article className="panel wb-panel" style={{ marginBottom: 20 }}>
      <div className="panel-heading">
        <div>
          <h2>Website secrets and settings</h2>
          <p>Store private passwords, API keys and configuration values used by this website's backend.</p>
        </div>
        <span className="wb-count">{variables.length} settings</span>
      </div>

      <div className="pm-resource-notice" role="note">
        Saved values are encrypted and hidden after you save them. You can replace or delete a value at any time. Backend execution is currently disabled and will be enabled only after the production security checks pass.
      </div>

      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <div className="pm-resource-notice" role="status">{notice}</div>}

      <form onSubmit={saveVariable} style={{ display: "grid", gap: 12, margin: "18px 0" }}>
        <strong>{editingName ? `Update ${editingName}` : "Add a website secret or setting"}</strong>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Setting name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Example: PAYMENT_API_KEY"
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
            placeholder={editingName ? "Enter the replacement value" : "Enter the private value"}
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
            {saving ? "Saving..." : editingName ? "Save changes" : "Save secret or setting"}
          </button>
          {editingName && <button className="secondary-button" type="button" onClick={resetForm} disabled={saving}>Cancel</button>}
        </div>
      </form>

      <div style={{ borderTop: "1px solid var(--border-color, #ddd)", paddingTop: 14 }}>
        <h3>Saved website secrets and settings</h3>
        {loading ? (
          <p>Loading website settings...</p>
        ) : variables.length === 0 ? (
          <p>No website secrets or settings have been saved yet.</p>
        ) : (
          <div className="wb-file-list">
            {variables.map((variable) => (
              <div className="wb-file-row" key={variable.name}>
                <div className="wb-file-info">
                  <strong>{variable.name}</strong>
                  <small>Value hidden · Stored securely</small>
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
        {!loading && error && <button type="button" className="secondary-button" onClick={() => void loadVariables()}>Retry</button>}
      </div>
      {siteType === "node" && <p style={{ marginTop: 14, fontSize: 13 }}>These secrets will be supplied privately to your Node.js backend when secure runtime execution is enabled.</p>}
    </article>
  );
}
