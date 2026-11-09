import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import ResourceWorkbench from "./ResourceWorkbench";

type Project = {
  id: string;
  name: string;
};

type ResourceStatus = "active" | "draft" | "published" | "archived";

type Resource = {
  id: string;
  project_id: string;
  name: string;
  description?: string;
  engine?: string;
  schema_name?: string;
  site_type?: "static" | "node";
  status: ResourceStatus;
  created_at: string;
  updated_at: string;
};

type ResourceManagerProps = {
  project: Project;
  onBack: () => void;
};

type ListResponse = {
  success: boolean;
  count: number;
  resources: Resource[];
  message?: string;
};

type SingleResponse = {
  success: boolean;
  resource: Resource;
  message?: string;
};

export default function ProjectResources({
  project,
  onBack,
}: ResourceManagerProps) {
  const product = import.meta.env.VITE_PRODUCT_NAME || "DSquare";
  const isDatabase = import.meta.env.VITE_PRODUCT_KIND === "database";
  const resourceLabel = isDatabase ? "Databases" : "Websites";

  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedResource, setSelectedResource] = useState<Resource | null>(null);
  const [managingResource, setManagingResource] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [siteType, setSiteType] = useState<"static" | "node">("static");

  const baseUrl = `/api/v1/projects/${project.id}/resources`;

  useEffect(() => {
    let cancelled = false;

    async function fetchResources() {
      setLoading(true);
      setError("");

      try {
        const response = await fetch(
          `${baseUrl}?includeArchived=${showArchived}`
        );
        const data = (await response.json()) as ListResponse;

        if (!response.ok) {
          throw new Error(data.message || "Could not load resources.");
        }

        if (!cancelled) {
          setResources(data.resources || []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load resources."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchResources();

    return () => {
      cancelled = true;
    };
  }, [baseUrl, showArchived]);

  async function reloadResources() {
    const response = await fetch(
      `${baseUrl}?includeArchived=${showArchived}`
    );
    const data = (await response.json()) as ListResponse;

    if (!response.ok) {
      throw new Error(data.message || "Could not refresh resources.");
    }

    setResources(data.resources || []);
  }

  function startCreate() {
    setSelectedResource(null);
    setEditingResource(null);
    setName("");
    setDescription("");
    setSiteType("static");
    setError("");
    setShowForm(true);
  }

  function startEdit(resource: Resource) {
    setEditingResource(resource);
    setName(resource.name);
    setDescription(resource.description || "");
    setSiteType(resource.site_type === "node" ? "node" : "static");
    setSelectedResource(null);
    setError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingResource(null);
    setName("");
    setDescription("");
    setSiteType("static");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const trimmedName = name.trim();

    if (!trimmedName) {
      setError("Enter a resource name.");
      return;
    }

    setSaving(true);

    try {
      const isEditing = editingResource !== null;
      const url = isEditing
        ? `${baseUrl}/${editingResource.id}`
        : baseUrl;

      const payload: Record<string, string> = {
        name: trimmedName,
      };

      if (!isDatabase) {
        payload.description = description.trim();
        if (!isEditing) payload.siteType = siteType;
      }

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not save the resource.");
      }

      closeForm();
      setSelectedResource(data.resource);
      await reloadResources();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the resource."
      );
    } finally {
      setSaving(false);
    }
  }

  async function openResource(id: string) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${baseUrl}/${id}`);
      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not open the resource.");
      }

      setSelectedResource(data.resource);
      setShowForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not open the resource."
      );
    } finally {
      setLoading(false);
    }
  }

  async function togglePublish(resource: Resource) {
    const nextStatus: ResourceStatus =
      resource.status === "published" ? "draft" : "published";

    setSaving(true);
    setError("");

    try {
      const response = await fetch(`${baseUrl}/${resource.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not update publishing status.");
      }

      setSelectedResource(data.resource);
      await reloadResources();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update publishing status."
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleArchive(resource: Resource) {
    const nextStatus: ResourceStatus =
      resource.status === "archived"
        ? isDatabase ? "active" : "draft"
        : "archived";

    if (
      nextStatus === "archived" &&
      !window.confirm(`Archive "${resource.name}"?`)
    ) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(`${baseUrl}/${resource.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not update the resource.");
      }

      setSelectedResource(data.resource);
      await reloadResources();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update the resource."
      );
    } finally {
      setSaving(false);
    }
  }

  function formatDate(value: string) {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  const publishedUrl = selectedResource && selectedResource.status === "published" && !isDatabase
    ? `${window.location.origin}/api/v1/projects/${project.id}/resources/${selectedResource.id}/published`
    : "";

  const visibleResources = resources
    .filter((resource) =>
      showArchived
        ? resource.status === "archived"
        : resource.status !== "archived"
    )
    .filter((resource) => {
      const term = search.trim().toLowerCase();

      return (
        !term ||
        resource.name.toLowerCase().includes(term) ||
        (resource.description || "").toLowerCase().includes(term)
      );
    });

  return (
    <section className="pm-page">
      <div className="pm-heading">
        <div>
          <button className="pm-back" onClick={onBack}>
            â† Back to project
          </button>
          <div className="welcome-date pm-resource-eyebrow">
            PROJECT RESOURCES
          </div>
          <h1>{resourceLabel}</h1>
          <p>
            {project.name} Â· Manage this project's {resourceLabel.toLowerCase()}.
          </p>
        </div>

        {!selectedResource && (
          <button className="primary-button" onClick={startCreate}>
            <span>ï¼‹</span> Create {isDatabase ? "database" : "website"}
          </button>
        )}
      </div>

      {error && (
        <div className="pm-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">
            Ã—
          </button>
        </div>
      )}

      {showForm ? (
        <form className="pm-form panel" onSubmit={handleSubmit}>
          <div className="pm-form-heading">
            <div>
              <h2>{editingResource ? "Edit resource" : `Create ${isDatabase ? "database" : "website"}`}</h2>
              <p>
                {isDatabase
                  ? "Create a PostgreSQL schema inside this project."
                  : "Choose static hosting for frontend-only sites or Node.js for a backend project. Node execution will be enabled after the isolated runtime is ready."}
              </p>
            </div>
            <button
              type="button"
              className="pm-close"
              onClick={closeForm}
              aria-label="Close form"
            >
              Ã—
            </button>
          </div>

          <label htmlFor="resource-name">Name</label>
          <input
            id="resource-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={isDatabase ? "e.g. Orders Database" : "e.g. Company Website"}
            maxLength={80}
            required
          />

          {!isDatabase && !editingResource && (
            <>
              <label htmlFor="resource-site-type">Website type</label>
              <select
                id="resource-site-type"
                value={siteType}
                onChange={(event) => setSiteType(event.target.value as "static" | "node")}
              >
                <option value="static">Static website (HTML/CSS/JS)</option>
                <option value="node">Node.js backend website (Node 22)</option>
              </select>
              <p className="pm-help">
                Node.js projects can be configured and validated now, but publishing stays disabled until secure isolated execution is available.
              </p>
            </>
          )}

          {!isDatabase && (
            <>
              <label htmlFor="resource-description">Description</label>
              <textarea
                id="resource-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Describe this website (optional)."
                maxLength={5000}
                rows={4}
              />
            </>
          )}

          <div className="pm-form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={closeForm}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={saving}>
              {saving
                ? "Saving..."
                : editingResource
                  ? "Save changes"
                  : `Create ${isDatabase ? "database" : "website"}`}
            </button>
          </div>
        </form>
      ) : managingResource && selectedResource ? (
        <ResourceWorkbench
          projectId={project.id}
          resource={selectedResource}
          onBack={() => setManagingResource(false)}
        />
      ) : selectedResource ? (
        <article className="pm-detail panel">
          <button
            className="pm-back"
            onClick={() => setSelectedResource(null)}
          >
            â† Back to {resourceLabel.toLowerCase()}
          </button>

          <div className="pm-detail-heading">
            <div className="pm-project-avatar">
              {selectedResource.name.charAt(0).toUpperCase()}
            </div>
            <div className="pm-detail-title">
              <h2>{selectedResource.name}</h2>
              <span className={`pm-status ${selectedResource.status}`}>
                {selectedResource.status}
              </span>
            </div>
          </div>

          <div className="pm-detail-description">
            {selectedResource.description ||
              (isDatabase
                ? "PostgreSQL database schema resource."
                : "Static website resource. It has not been deployed yet.")}
          </div>

          <div className="pm-detail-meta">
            <div>
              <span>Resource ID</span>
              <strong>{selectedResource.id}</strong>
            </div>
            <div>
              <span>{isDatabase ? "Database engine" : "Website type"}</span>
              <strong>
                {isDatabase
                  ? selectedResource.engine || "PostgreSQL"
                  : selectedResource.site_type || "Static"}
              </strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{formatDate(selectedResource.created_at)}</strong>
            </div>
            {selectedResource.schema_name && (
              <div>
                <span>PostgreSQL schema</span>
                <strong>{selectedResource.schema_name}</strong>
              </div>
            )}
          </div>

          {!isDatabase && selectedResource.status === "published" && (
            <div className="pm-resource-notice space-y-3">
              <div>This website is published and available at its public URL:</div>
              <a href={publishedUrl} target="_blank" rel="noreferrer" className="block break-all font-medium underline">
                {publishedUrl}
              </a>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void navigator.clipboard.writeText(publishedUrl)}
                >
                  Copy public URL
                </button>
                <a href={publishedUrl} target="_blank" rel="noreferrer" className="secondary-button">
                  Visit website
                </a>
              </div>
            </div>
          )}

          <div className="pm-detail-actions">
            {!isDatabase && selectedResource.status !== "archived" && (
              <button
                className="secondary-button"
                onClick={() => void togglePublish(selectedResource)}
                disabled={saving}
              >
                {saving
                  ? "Please wait..."
                  : selectedResource.status === "published"
                    ? "Unpublish"
                    : "Publish"}
              </button>
            )}
            <button
              className="secondary-button"
              onClick={() => setManagingResource(true)}
              disabled={saving}
            >
              {isDatabase ? "Manage tables" : "Manage files"}
            </button>
            <button
              className="secondary-button"
              onClick={() => startEdit(selectedResource)}
              disabled={saving}
            >
              Edit resource
            </button>
            <button
              className="pm-archive-button"
              onClick={() => void toggleArchive(selectedResource)}
              disabled={saving}
            >
              {saving
                ? "Please wait..."
                : selectedResource.status === "archived"
                  ? "Restore resource"
                  : "Archive resource"}
            </button>
          </div>
        </article>
      ) : (
        <>
          <div className="pm-resource-summary">
            <div className="pm-resource-summary-item">
              <span>Total {resourceLabel.toLowerCase()}</span>
              <strong>{resources.filter((item) => item.status !== "archived").length}</strong>
            </div>
            <div className="pm-resource-summary-item">
              <span>Archived</span>
              <strong>{resources.filter((item) => item.status === "archived").length}</strong>
            </div>
            <div className="pm-resource-summary-item">
              <span>Project</span>
              <strong>{project.name}</strong>
            </div>
          </div>

          <div className="pm-toolbar">
            <div className="pm-tabs">
              <button
                className={!showArchived ? "active" : ""}
                onClick={() => setShowArchived(false)}
              >
                Active
              </button>
              <button
                className={showArchived ? "active" : ""}
                onClick={() => setShowArchived(true)}
              >
                Archived
              </button>
            </div>

            <input
              className="pm-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${resourceLabel.toLowerCase()}...`}
              aria-label="Search resources"
            />
          </div>

          {loading ? (
            <div className="pm-empty panel">
              <div className="pm-spinner" />
              <strong>Loading resources...</strong>
            </div>
          ) : visibleResources.length > 0 ? (
            <div className="pm-project-grid">
              {visibleResources.map((resource) => (
                <article className="pm-project-card panel" key={resource.id}>
                  <div className="pm-card-top">
                    <div className="pm-project-avatar">
                      {isDatabase ? "â—ˆ" : "â—Ž"}
                    </div>
                    <span className={`pm-status ${resource.status}`}>
                      {resource.status}
                    </span>
                  </div>

                  <h3>{resource.name}</h3>
                  <p className="pm-card-description">
                    {isDatabase
                      ? `PostgreSQL Â· ${resource.engine || "Database"}`
                      : resource.description || "Static website Â· Not deployed"}
                  </p>

                  <div className="pm-card-footer">
                    <span>Created {formatDate(resource.created_at)}</span>
                    <button onClick={() => void openResource(resource.id)}>
                      Open resource â†’
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="pm-empty panel">
              <div className="pm-empty-icon">{isDatabase ? "â—ˆ" : "â—Ž"}</div>
              <h2>
                {search
                  ? "No matching resources"
                  : showArchived
                    ? "No archived resources"
                    : `No ${resourceLabel.toLowerCase()} yet`}
              </h2>
              <p>
                {search
                  ? "Try another search term."
                  : showArchived
                    ? "Resources you archive will appear here."
                    : `Create the first ${isDatabase ? "database" : "website"} resource for ${project.name}.`}
              </p>
              {!search && !showArchived && (
                <button className="primary-button" onClick={startCreate}>
                  <span>ï¼‹</span> Create {isDatabase ? "database" : "website"}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

