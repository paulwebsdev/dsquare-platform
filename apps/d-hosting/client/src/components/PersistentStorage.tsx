import { useCallback, useEffect, useState } from "react";

type Backup = {
  backupId: string;
  resourceId: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

type StorageResponse = {
  success?: boolean;
  message?: string;
  usedBytes?: number;
  backups?: Backup[];
  backup?: Backup;
  restoredFiles?: number;
  restoredBytes?: number;
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function PersistentStorage({ resourceUrl }: { resourceUrl: string }) {
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [usageResponse, backupsResponse] = await Promise.all([
        fetch(`${resourceUrl}/storage/usage`, { credentials: "same-origin" }),
        fetch(`${resourceUrl}/storage/backups`, { credentials: "same-origin" }),
      ]);
      const usage = await usageResponse.json() as StorageResponse;
      const history = await backupsResponse.json() as StorageResponse;
      if (!usageResponse.ok) throw new Error(usage.message || "Persistent storage usage is unavailable.");
      if (!backupsResponse.ok) throw new Error(history.message || "Persistent backup history is unavailable.");
      if (typeof usage.usedBytes !== "number" || !Number.isSafeInteger(usage.usedBytes)) {
        throw new Error("The runtime agent returned invalid storage usage.");
      }
      setUsedBytes(usage.usedBytes);
      setBackups(history.backups || []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load persistent storage.");
    } finally {
      setLoading(false);
    }
  }, [resourceUrl]);

  useEffect(() => { void load(); }, [load]);

  async function createBackup() {
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/storage/backups`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await response.json() as StorageResponse;
      if (!response.ok) throw new Error(data.message || "Could not create a backup.");
      setNotice("Persistent storage backup created and verified.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a backup.");
    } finally {
      setBusy("");
    }
  }

  async function restoreBackup(backup: Backup) {
    if (!window.confirm("Restore this persistent-storage backup? The website runtime must be stopped first.")) return;
    setBusy(backup.backupId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/storage/backups/${encodeURIComponent(backup.backupId)}/restore`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await response.json() as StorageResponse;
      if (!response.ok) throw new Error(data.message || "Could not restore this backup.");
      setNotice(`Restored ${data.restoredFiles ?? 0} files (${formatBytes(data.restoredBytes ?? 0)}).`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    } finally {
      setBusy("");
    }
  }

  async function deleteBackup(backup: Backup) {
    if (!window.confirm("Permanently delete this backup? This cannot be undone.")) return;
    setBusy(backup.backupId);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${resourceUrl}/storage/backups/${encodeURIComponent(backup.backupId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const data = await response.json() as StorageResponse;
      if (!response.ok) throw new Error(data.message || "Could not delete this backup.");
      setNotice("Backup deleted.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete this backup.");
    } finally {
      setBusy("");
    }
  }

  return (
    <article className="panel wb-panel">
      <div className="panel-heading">
        <div>
          <h2>Persistent runtime storage</h2>
          <p>Storage used by your Node.js backend between deployments and restarts.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void load()} disabled={loading || Boolean(busy)}>
          Refresh
        </button>
      </div>
      {error && <div className="pm-error" role="alert">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      {loading ? <p>Loading persistent storage...</p> : (
        <>
          <div className="system-row"><span>Used storage</span><strong>{usedBytes === null ? "Unavailable" : formatBytes(usedBytes)}</strong></div>
          <div className="pm-form-actions">
            <button className="primary-button" type="button" onClick={() => void createBackup()} disabled={Boolean(busy)}>
              {busy === "create" ? "Creating backup..." : "Create backup"}
            </button>
          </div>
          <h3>Persistent storage backups</h3>
          {backups.length ? (
            <div className="wb-file-list">
              {backups.map((backup) => (
                <div className="wb-file-row" key={backup.backupId}>
                  <div className="wb-file-info">
                    <strong>{new Date(backup.createdAt).toLocaleString()}</strong>
                    <small>{formatBytes(backup.sizeBytes)} · SHA-256 {backup.sha256.slice(0, 16)}…</small>
                  </div>
                  <div className="wb-file-actions">
                    <button className="secondary-button" type="button" onClick={() => void restoreBackup(backup)} disabled={Boolean(busy)}>
                      {busy === backup.backupId ? "Working..." : "Restore"}
                    </button>
                    <button className="danger" type="button" onClick={() => void deleteBackup(backup)} disabled={Boolean(busy)}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="wb-help">No persistent-storage backups are available yet.</p>}
        </>
      )}
      <p className="wb-help">Persistent runtime storage is separate from website deployment files and uploaded media. Backup restore is blocked while the website runtime is running.</p>
    </article>
  );
}
