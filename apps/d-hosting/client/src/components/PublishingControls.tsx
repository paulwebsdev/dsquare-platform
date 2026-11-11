import { useEffect, useState } from "react";

type PublishingControlsProps = {
  resourceUrl: string;
  initialStatus: string;
};

export default function PublishingControls({
  resourceUrl,
  initialStatus,
}: PublishingControlsProps) {
  const [status, setStatus] = useState(initialStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const handleStatusChange = (event: Event) => {
      const nextStatus = (event as CustomEvent<{ status?: string }>).detail?.status;
      if (nextStatus) setStatus(nextStatus);
    };
    window.addEventListener("dsquare:hosting-status-change", handleStatusChange);
    return () => window.removeEventListener("dsquare:hosting-status-change", handleStatusChange);
  }, []);

  async function changeStatus() {
    const nextStatus = status === "published" ? "draft" : "published";
    const action = nextStatus === "published" ? "publish" : "unpublish";

    if (!window.confirm(
      nextStatus === "published"
        ? "Publish this website? Anyone with its public URL will be able to view it."
        : "Unpublish this website? Its public URL will stop serving the website."
    )) return;

    setSaving(true);
    setError("");

    try {
      const response = await fetch(resourceUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || `Could not ${action} website.`);
      }

      setStatus(data.resource?.status || nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action} website.`);
    } finally {
      setSaving(false);
    }
  }

  const isPublished = status === "published";

  return (
    <section className="panel wb-panel" aria-labelledby="publishing-heading">
      <div className="panel-heading">
        <div>
          <h2 id="publishing-heading">Website publishing</h2>
          <p>Control whether visitors can access this website publicly.</p>
        </div>
        <span className={`pm-status ${isPublished ? "active" : ""}`}>
          {isPublished ? "Published" : status === "archived" ? "Archived" : "Draft"}
        </span>
      </div>
      {error && <p className="pm-error" role="alert">{error}</p>}
      <button
        type="button"
        className={isPublished ? "secondary-button" : "primary-button"}
        onClick={() => void changeStatus()}
        disabled={saving || status === "archived"}
      >
        {saving ? "Saving..." : isPublished ? "Unpublish website" : "Publish website"}
      </button>
    </section>
  );
}
