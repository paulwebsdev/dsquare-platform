import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import ProjectResources from "./ProjectResources";

type Project = {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
};

type ProjectManagerProps = {
  onProjectsChange: () => Promise<void>;
  initialProjectId?: string | null;
  initialResourceId?: string | null;
  onInitialResourceOpened?: () => void;
};

type ListResponse = {
  success: boolean;
  count: number;
  projects: Project[];
  message?: string;
};

type SingleResponse = {
  success: boolean;
  project: Project;
  message?: string;
};

export default function ProjectManager({
  onProjectsChange,
  initialProjectId,
  initialResourceId,
  onInitialResourceOpened,
}: ProjectManagerProps) {
  const product = import.meta.env.VITE_PRODUCT_NAME || "DSquare";
  const projectType = import.meta.env.VITE_PRODUCT_KIND === "database" ? "database" : "website";

  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [managingResources, setManagingResources] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  async function loadProjects() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/v1/projects?includeArchived=${showArchived}`
      );
      const data = (await response.json()) as ListResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not load projects.");
      }

      setProjects(data.projects || []);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load projects."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, [showArchived]);

  useEffect(() => {
    let active = true;
    if (!initialProjectId) return;
    fetch(`/api/v1/projects/${encodeURIComponent(initialProjectId)}`, { credentials: "same-origin" })
      .then(async (response) => {
        const data = await response.json() as SingleResponse;
        if (!response.ok) throw new Error(data.message || "Could not open the selected project.");
        if (active) {
          setSelectedProject(data.project);
          setManagingResources(true);
          onInitialResourceOpened?.();
        }
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not open the selected project."); });
    return () => { active = false; };
  }, [initialProjectId]);

  function startCreate() {
    setSelectedProject(null);
    setEditingProject(null);
    setName("");
    setDescription("");
    setError("");
    setShowForm(true);
  }

  function startEdit(project: Project) {
    setSelectedProject(null);
    setEditingProject(project);
    setName(project.name);
    setDescription(project.description);
    setError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingProject(null);
    setName("");
    setDescription("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    if (!trimmedName) {
      setError("Enter a project name.");
      return;
    }

    setSaving(true);

    try {
      const isEditing = editingProject !== null;

      const response = await fetch(
        isEditing
          ? `/api/v1/projects/${editingProject.id}`
          : "/api/v1/projects",
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmedName,
            description: trimmedDescription,
          }),
        }
      );

      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not save the project.");
      }

      closeForm();
      setSelectedProject(data.project);
      await loadProjects();
      await onProjectsChange();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the project."
      );
    } finally {
      setSaving(false);
    }
  }

  async function openProject(id: string) {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`/api/v1/projects/${id}`);
      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not open the project.");
      }

      setSelectedProject(data.project);
      setShowForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not open the project."
      );
    } finally {
      setLoading(false);
    }
  }

  async function toggleArchive(project: Project) {
    const nextStatus =
      project.status === "active" ? "archived" : "active";

    if (
      nextStatus === "archived" &&
      !window.confirm(`Archive "${project.name}"? You can restore it later.`)
    ) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });

      const data = (await response.json()) as SingleResponse;

      if (!response.ok) {
        throw new Error(data.message || "Could not update the project.");
      }

      setSelectedProject(data.project);
      await loadProjects();
      await onProjectsChange();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not update the project."
      );
    } finally {
      setSaving(false);
    }
  }

  const visibleProjects = projects
    .filter((project) =>
      showArchived
        ? project.status === "archived"
        : project.status === "active"
    )
    .filter((project) => {
      const term = search.trim().toLowerCase();

      return (
        !term ||
        project.name.toLowerCase().includes(term) ||
        project.description.toLowerCase().includes(term)
      );
    });

  function formatDate(value: string) {
    return new Date(value).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return (
    <section className="pm-page">
      <div className="pm-heading">
        <div>
          <div className="welcome-date">WORKSPACE MANAGEMENT</div>
          <h1>Projects</h1>
          <p>Organize and manage your {product} projects.</p>
        </div>

        {!selectedProject && (
          <button className="primary-button" onClick={startCreate}>
            <span>＋</span> Create project
          </button>
        )}
      </div>

      {error && (
        <div className="pm-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {showForm ? (
        <form className="pm-form panel" onSubmit={handleSubmit}>
          <div className="pm-form-heading">
            <div>
              <h2>{editingProject ? "Edit project" : "Create a project"}</h2>
              <p>
                {editingProject
                  ? "Update your project details."
                  : `Set up a new ${projectType} project.`}
              </p>
            </div>
            <button
              type="button"
              className="pm-close"
              onClick={closeForm}
              aria-label="Close form"
            >
              ×
            </button>
          </div>

          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              projectType === "database"
                ? "e.g. Customer Management"
                : "e.g. My Business Website"
            }
            maxLength={80}
            required
          />

          <label htmlFor="project-description">Description</label>
          <textarea
            id="project-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this project about? (Optional)"
            maxLength={5000}
            rows={4}
          />

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
                : editingProject
                  ? "Save changes"
                  : "Create project"}
            </button>
          </div>
        </form>
      ) : managingResources && selectedProject ? (
        <ProjectResources
          project={selectedProject}
          onBack={() => setManagingResources(false)}
          initialResourceId={initialResourceId}
          onInitialResourceOpened={onInitialResourceOpened}
        />
      ) : selectedProject ? (
        <article className="pm-detail panel">
          <button
            className="pm-back"
            onClick={() => {
              setSelectedProject(null);
              setError("");
            }}
          >
            ← Back to projects
          </button>

          <div className="pm-detail-heading">
            <div className="pm-project-avatar">
              {selectedProject.name.charAt(0).toUpperCase()}
            </div>
            <div className="pm-detail-title">
              <h2>{selectedProject.name}</h2>
              <span className={`pm-status ${selectedProject.status}`}>
                {selectedProject.status}
              </span>
            </div>
          </div>

          <div className="pm-detail-description">
            {selectedProject.description || "No description has been added."}
          </div>

          <div className="pm-detail-meta">
            <div>
              <span>Project ID</span>
              <strong>{selectedProject.id}</strong>
            </div>
            <div>
              <span>Created</span>
              <strong>{formatDate(selectedProject.created_at)}</strong>
            </div>
            <div>
              <span>Last updated</span>
              <strong>{formatDate(selectedProject.updated_at)}</strong>
            </div>
          </div>

          <div className="pm-detail-actions">
            <button
              className="secondary-button"
              onClick={() => startEdit(selectedProject)}
              disabled={saving}
            >
              Edit project
            </button>
            <button
              className="secondary-button"
              onClick={() => setManagingResources(true)}
              disabled={saving}
              >
                Manage resources
              </button>
            <button
              className="pm-archive-button"
              onClick={() => void toggleArchive(selectedProject)}
              disabled={saving}
            >
              {saving
                ? "Please wait..."
                : selectedProject.status === "active"
                  ? "Archive project"
                  : "Restore project"}
            </button>
          </div>
        </article>
      ) : (
        <>
          <div className="pm-toolbar">
            <div className="pm-tabs">
              <button
                className={!showArchived ? "active" : ""}
                onClick={() => setShowArchived(false)}
              >
                Active projects
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
              placeholder="Search projects..."
              aria-label="Search projects"
            />
          </div>

          {loading ? (
            <div className="pm-empty panel">
              <div className="pm-spinner" />
              <strong>Loading projects...</strong>
            </div>
          ) : visibleProjects.length > 0 ? (
            <div className="pm-project-grid">
              {visibleProjects.map((project) => (
                <article className="pm-project-card panel" key={project.id}>
                  <div className="pm-card-top">
                    <div className="pm-project-avatar">
                      {project.name.charAt(0).toUpperCase()}
                    </div>
                    <span className={`pm-status ${project.status}`}>
                      {project.status}
                    </span>
                  </div>

                  <h3>{project.name}</h3>
                  <p className="pm-card-description">
                    {project.description || "No description added."}
                  </p>

                  <div className="pm-card-footer">
                    <span>Created {formatDate(project.created_at)}</span>
                    <button onClick={() => void openProject(project.id)}>
                      Open project →
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="pm-empty panel">
              <div className="pm-empty-icon">▦</div>
              <h2>
                {search
                  ? "No matching projects"
                  : showArchived
                    ? "No archived projects"
                    : "Your projects start here"}
              </h2>
              <p>
                {search
                  ? "Try another search term."
                  : showArchived
                    ? "Projects you archive will appear here."
                    : `Create your first ${projectType} project to get started.`}
              </p>
              {!search && !showArchived && (
                <button className="primary-button" onClick={startCreate}>
                  <span>＋</span> Create your first project
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}