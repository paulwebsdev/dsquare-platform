import { useEffect, useState } from "react";

type Backup = {
  id: string;
  provider: string;
  checksum_sha256: string | null;
  size_bytes: number | string | null;
  status: string;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  restored_at: string | null;
  created_at: string;
};

const PAGE_SIZE = 10;

function formatBytes(value: number | string | null) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

export default function DatabaseBackups({ baseUrl }: { baseUrl: string }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load(nextOffset = 0, append = false) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${baseUrl}/backups?limit=${PAGE_SIZE}&offset=${nextOffset}`, { credentials: "same-origin" });
      const data = await response.json() as { backups?: Backup[]; message?: string };
      if (!response.ok) throw new Error(data.message || "Could not load backup history.");
      const page = data.backups || [];
      setBackups(current => append ? [...current, ...page] : page);
      setOffset(nextOffset);
      setHasMore(page.length === PAGE_SIZE);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load backup history.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [baseUrl]);

  async function restore(backup: Backup) {
    if (backup.status !== "completed" || !window.confirm("Restore this backup? A verified safety backup will be created before the restore.")) return;
    setRestoring(backup.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${baseUrl}/backups/${encodeURIComponent(backup.id)}/restore`, {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await response.json() as { message?: string };
      if (!response.ok) throw new Error(data.message || "Could not restore this backup.");
      setMessage(data.message || "Backup restored successfully.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not restore this backup.");
    } finally {
      setRestoring("");
    }
  }

  return (
    <article className="panel wb-panel">
      <div className="panel-heading">
        <div><h2>Automatic backups</h2><p>Review completed backups and restore a verified snapshot when needed.</p></div>
        <span className="wb-count">{backups.length} shown</span>
      </div>
      {error && <div className="wb-help" role="alert">{error}</div>}
      {message && <div className="wb-help" role="status">{message}</div>}
      <p className="wb-help">Automatic scheduling requires the server backup scheduler and S3-compatible storage to be configured. This page does not create a backup on demand.</p>
      {loading && backups.length === 0 ? <p className="wb-help">Loading backup history...</p> : backups.length ? (
        <div className="wb-table-scroll">
          {backups.map(backup => (
            <div className="wb-file-row" key={backup.id}>
              <div className="wb-file-info">
                <strong>{new Date(backup.created_at).toLocaleString()} · {backup.status}</strong>
                <small>{formatBytes(backup.size_bytes)} · {backup.provider}{backup.expires_at ? ` · Expires ${new Date(backup.expires_at).toLocaleDateString()}` : ""}</small>
                {backup.checksum_sha256 && <small>SHA-256: <code>{backup.checksum_sha256.slice(0, 16)}…</code></small>}
                {backup.error_code && <small>{backup.error_code}</small>}
              </div>
              <button className="primary-button" disabled={loading || restoring !== "" || backup.status !== "completed"} onClick={() => void restore(backup)}>
                {restoring === backup.id ? "Restoring..." : "Restore"}
              </button>
            </div>
          ))}
        </div>
      ) : !loading ? <p className="wb-help">No backup history is available yet. Check the server backup scheduler and storage configuration.</p> : null}
      {hasMore && <button className="secondary-button" disabled={loading} onClick={() => void load(offset + PAGE_SIZE, true)}>Load more backups</button>}
    </article>
  );
}
