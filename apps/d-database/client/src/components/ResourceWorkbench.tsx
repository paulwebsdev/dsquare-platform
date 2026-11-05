import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import VisualQueryBuilder from "./VisualQueryBuilder";

type WorkResource = {
  id: string;
  name: string;
  status: string;
};

type WorkbenchProps = {
  projectId: string;
  resource: WorkResource;
  onBack: () => void;
};

type TableSummary = {
  table_name: string;
  column_count: number;
};

type DbColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
  is_primary_key?: boolean;
};

type DbRow = Record<string, unknown>;

type StoredFile = {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number | string;
  created_at: string;
};

type DbType =
  | "text"
  | "integer"
  | "bigint"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamptz"
  | "uuid"
  | "jsonb";

const DB_TYPES: DbType[] = [
  "text",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "date",
  "timestamptz",
  "uuid",
  "jsonb",
];

const ALLOWED_FILE_INPUT =
  ".html,.htm,.css,.js,.mjs,.json,.txt,.md,.xml,.svg,.png,.jpg,.jpeg,.gif,.webp,.avif,.ico,.woff,.woff2,.ttf,.otf,.mp4,.webm,.mp3,.pdf";

export default function ResourceWorkbench({
  projectId,
  resource,
  onBack,
}: WorkbenchProps) {
  const product = import.meta.env.VITE_PRODUCT_NAME || "DSquare";
  const isDatabase = import.meta.env.VITE_PRODUCT_KIND === "database";

  const baseUrl =
    `/api/v1/projects/${projectId}/resources/${resource.id}`;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // D Database state
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const primaryKeyColumn = columns.find((column) => column.is_primary_key);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [rowOffset, setRowOffset] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [rowSearch, setRowSearch] = useState("");
  const filteredRows = rows.filter((row) =>
    columns.some((column) =>
      recordValueToString(row[column.column_name])
        .toLowerCase()
        .includes(rowSearch.trim().toLowerCase())
    )
  );
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const sortedRows = [...filteredRows].sort((a, b) => {
    if (!sortColumn) return 0;

    const aValue = recordValueToString(a[sortColumn]);
    const bValue = recordValueToString(b[sortColumn]);
    const comparison = aValue.localeCompare(bValue, undefined, {
      numeric: true,
      sensitivity: "base",
    });

    return sortDirection === "asc" ? comparison : -comparison;
  });
  const [showRecordForm, setShowRecordForm] = useState(false);
  const [editingRow, setEditingRow] = useState<DbRow | null>(null);
  const [recordValues, setRecordValues] = useState<Record<string, string>>({});
  const [recordSaving, setRecordSaving] = useState(false);
  const [tableName, setTableName] = useState("");
  const [showTableForm, setShowTableForm] = useState(false);
  const [columnAction, setColumnAction] = useState<"add" | "rename" | "drop">("add");
  const [columnName, setColumnName] = useState("");
  const [newColumnName, setNewColumnName] = useState("");
  const [columnType, setColumnType] = useState<DbType>("text");
  const [columnSaving, setColumnSaving] = useState(false);
  const [newColumns, setNewColumns] = useState<
    { name: string; type: DbType; nullable: boolean; primaryKey: boolean }[]
  >([
    { name: "id", type: "text", nullable: false, primaryKey: true },
    { name: "name", type: "text", nullable: true, primaryKey: false },
  ]);

  // D Hosting state
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(false);

  async function loadTables() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${baseUrl}/tables`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not load tables.");
      }

      setTables(data.tables || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tables.");
    } finally {
      setLoading(false);
    }
  }

  async function loadFiles() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${baseUrl}/files`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not load files.");
      }

      setFiles(data.files || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load files.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isDatabase) {
      void loadTables();
    } else {
      void loadFiles();
    }
  }, [baseUrl, isDatabase]);

  async function loadRows(table: string, nextOffset: number, nextPageSize = pageSize) {
    const response = await fetch(
      `${baseUrl}/tables/${encodeURIComponent(table)}/rows?limit=${nextPageSize}&offset=${nextOffset}`
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Could not load table rows.");
    }

    setRows(data.rows || []);
    setRowTotal(Number(data.total || 0));
    setRowOffset(nextOffset);
  }

  async function openTable(name: string) {
    setLoading(true);
    setError("");

    try {
      const [columnResponse, rowResponse] = await Promise.all([
        fetch(`${baseUrl}/tables/${encodeURIComponent(name)}`),
        fetch(`${baseUrl}/tables/${encodeURIComponent(name)}/rows?limit=${pageSize}&offset=0`),
      ]);

      const columnData = await columnResponse.json();
      const rowData = await rowResponse.json();

      if (!columnResponse.ok) {
        throw new Error(columnData.message || "Could not inspect table.");
      }

      if (!rowResponse.ok) {
        throw new Error(rowData.message || "Could not load table rows.");
      }

      setColumns(columnData.columns || []);
      setRows(rowData.rows || []);
      setRowTotal(Number(rowData.total || 0));
      setRowOffset(0);
      setSelectedTable(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open table.");
    } finally {
      setLoading(false);
    }
  }

  async function renameTable(currentName: string) {
    const enteredName = window.prompt("Enter the new table name:", currentName);

    if (enteredName === null) return;

    const newName = enteredName.trim();

    if (!newName) {
      setError("Table name cannot be empty.");
      return;
    }

    setError("");
    setSaving(true);

    try {
      const response = await fetch(
        `${baseUrl}/tables/${encodeURIComponent(currentName)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newTableName: newName }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not rename the table.");
      }

      await loadTables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the table.");
    } finally {
      setSaving(false);
    }
  }
  async function saveColumnChange() {
    if (!selectedTable) return;

    const name = columnName.trim();
    const renamed = newColumnName.trim();

    if (!name) {
      setError("Enter a column name.");
      return;
    }

    if (columnAction === "rename" && !renamed) {
      setError("Enter the new column name.");
      return;
    }

    if (
      columnAction === "drop" &&
      !window.confirm(`Remove column "${name}" and its data? This cannot be undone.`)
    ) {
      return;
    }

    setColumnSaving(true);
    setError("");

    try {
      const body =
        columnAction === "add"
          ? { action: "add", columnName: name, type: columnType }
          : columnAction === "rename"
            ? { action: "rename", columnName: name, newColumnName: renamed }
            : { action: "drop", columnName: name };

      const response = await fetch(
        `${baseUrl}/tables/${encodeURIComponent(selectedTable)}/columns`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not update the column.");
      }

      setColumnName("");
      setNewColumnName("");
      await openTable(selectedTable);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the column.");
    } finally {
      setColumnSaving(false);
    }
  }
  function updateColumn(
    index: number,
    key: "name" | "type" | "nullable" | "primaryKey",
    value: string | boolean
  ) {
    setNewColumns((current) =>
      current.map((column, i) =>
        i === index ? { ...column, [key]: value } : column
      )
    );
  }

  function addColumn() {
    if (newColumns.length >= 30) {
      setError("A table can have at most 30 columns in this version.");
      return;
    }

    setNewColumns((current) => [
      ...current,
      {
        name: "",
        type: "text",
        nullable: true,
        primaryKey: false,
      },
    ]);
  }

  function removeColumn(index: number) {
    if (newColumns.length <= 1) {
      setError("A table must have at least one column.");
      return;
    }

    setNewColumns((current) => current.filter((_, i) => i !== index));
  }

  async function createTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const response = await fetch(`${baseUrl}/tables`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: tableName.trim(),
          columns: newColumns,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not create table.");
      }

      setShowTableForm(false);
      setTableName("");
      setNewColumns([
        { name: "id", type: "text", nullable: false, primaryKey: true },
        { name: "name", type: "text", nullable: true, primaryKey: false },
      ]);

      await loadTables();
      await openTable(data.table.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create table.");
    } finally {
      setSaving(false);
    }
  }

  function recordValueToString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
  }

  function startCreateRecord() {
    setEditingRow(null);
    setRecordValues(
      Object.fromEntries(columns.map((column) => [column.column_name, ""]))
    );
    setError("");
    setShowRecordForm(true);
  }

  function startEditRecord(row: DbRow) {
    setEditingRow(row);
    setRecordValues(
      Object.fromEntries(
        columns.map((column) => [
          column.column_name,
          recordValueToString(row[column.column_name]),
        ])
      )
    );
    setError("");
    setShowRecordForm(true);
  }

  async function saveRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedTable) return;

    setSaving(true);
    setError("");

    try {
      const values: Record<string, unknown> = {};

      for (const column of columns) {
        if (editingRow && column.is_primary_key) continue;

        const raw = recordValues[column.column_name] ?? "";
        const trimmed = raw.trim();

        if (trimmed === "" && column.is_nullable === "YES") {
          values[column.column_name] = null;
          continue;
        }

        if (trimmed === "" && column.column_default) {
          continue;
        }

        if (column.data_type === "json" || column.data_type === "jsonb") {
          if (trimmed === "") {
            values[column.column_name] = null;
          } else {
            values[column.column_name] = JSON.parse(trimmed);
          }
        } else if (column.data_type === "boolean") {
          values[column.column_name] =
            trimmed === "true" ? true : trimmed === "false" ? false : trimmed;
        } else {
          values[column.column_name] = raw;
        }
      }

      const isEditing = editingRow !== null;
      const primaryKey = columns.find((column) => column.is_primary_key);

      if (isEditing && !primaryKey) {
        throw new Error("This table does not have a supported primary key.");
      }

      if (isEditing && Object.keys(values).length === 0) {
        throw new Error("Change at least one field before saving.");
      }

      const payload = isEditing
        ? {
            primaryKeyValue: editingRow[primaryKey!.column_name],
            values,
          }
        : { values };

      const response = await fetch(
        `${baseUrl}/tables/${encodeURIComponent(selectedTable)}/rows`,
        {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not save the record.");
      }

      setShowRecordForm(false);
      setEditingRow(null);

      await openTable(selectedTable);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the record."
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord(row: DbRow) {
    if (!selectedTable) return;

    const primaryKey = columns.find((column) => column.is_primary_key);

    if (!primaryKey) {
      setError("This table does not have a supported primary key.");
      return;
    }

    const primaryValue = row[primaryKey.column_name];

    if (
      !window.confirm(
        `Permanently delete the record with ${primaryKey.column_name} = ${recordValueToString(primaryValue)}?`
      )
    ) {
      return;
    }

    setSaving(true);
    setError("");

    try {
      const response = await fetch(
        `${baseUrl}/tables/${encodeURIComponent(selectedTable)}/rows`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ primaryKeyValue: primaryValue }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not delete the record.");
      }

      await openTable(selectedTable);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not delete the record."
      );
    } finally {
      setSaving(false);
    }
  }
  async function uploadFile(file: File) {
    setError("");

    if (file.size === 0) {
      setError("The selected file is empty.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      setError("The maximum upload size is 10 MB.");
      return;
    }

    setUploading(true);

    try {
      const response = await fetch(`${baseUrl}/files`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: await file.arrayBuffer(),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not upload file.");
      }

      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload file.");
    } finally {
      setUploading(false);
    }
  }

  async function downloadFile(file: StoredFile) {
    setError("");

    try {
      const response = await fetch(
        `${baseUrl}/files/${file.id}/download`
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || "Could not download file.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = objectUrl;
      anchor.download = file.original_name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not download file.");
    }
  }

  async function renameFile(file: StoredFile) {
    const nextName = window.prompt("Enter the new file name:", file.original_name);

    if (!nextName || nextName.trim() === file.original_name) return;

    setError("");

    try {
      const response = await fetch(`${baseUrl}/files/${file.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not rename file.");
      }

      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename file.");
    }
  }

  async function deleteFile(file: StoredFile) {
    if (!window.confirm(`Permanently delete "${file.original_name}"?`)) return;

    setError("");

    try {
      const response = await fetch(`${baseUrl}/files/${file.id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Could not delete file.");
      }

      await loadFiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete file.");
    }
  }

  function formatSize(bytes: number | string) {
    const size = Number(bytes);

    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  function displayCell(value: unknown) {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  return (
    <section className="pm-page wb-page">
      <div className="pm-heading wb-heading">
        <div>
          <button className="pm-back" onClick={onBack}>
            Back to resource
          </button>
          <div className="welcome-date wb-eyebrow">
            {isDatabase ? "DATABASE TABLES" : "WEBSITE FILES"}
          </div>
          <h1>{resource.name}</h1>
          <p>
            {isDatabase
              ? "Create tables, inspect columns and view records."
              : "Upload and manage files for this website."}
          </p>
        </div>
        {isDatabase && !selectedTable && !showTableForm && (
          <button
            className="primary-button"
            onClick={() => {
              setError("");
              setShowTableForm(true);
            }}
          >
            <span>+</span> Create table
          </button>
        )}
      </div>

      {error && (
        <div className="pm-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss">
            ÃƒÆ’Ã¢â‚¬â€
          </button>
        </div>
      )}

      {isDatabase ? (
        <>
          {showTableForm ? (
            <form className="panel wb-form" onSubmit={createTable}>
              <div className="pm-form-heading">
                <div>
                  <h2>Create a table</h2>
                  <p>Define the table name and its columns.</p>
                </div>
                <button
                  type="button"
                  className="pm-close"
                  onClick={() => setShowTableForm(false)}
                >
                  ÃƒÆ’Ã¢â‚¬â€
                </button>
              </div>

              <label htmlFor="wb-table-name">Table name</label>
              <input
                id="wb-table-name"
                value={tableName}
                onChange={(event) => setTableName(event.target.value)}
                placeholder="e.g. orders"
                pattern="[a-z][a-z0-9_]{0,62}"
                maxLength={63}
                required
              />

              <div className="wb-columns-heading">
                <strong>Columns</strong>
                <button
                  type="button"
                  className="text-button"
                  onClick={addColumn}
                >
                  + Add column
                </button>
              </div>

              <div className="wb-column-list">
                {newColumns.map((column, index) => (
                  <div className="wb-column-editor" key={index}>
                    <input
                      aria-label={`Column ${index + 1} name`}
                      value={column.name}
                      onChange={(event) =>
                        updateColumn(index, "name", event.target.value)
                      }
                      placeholder="column_name"
                      pattern="[a-z][a-z0-9_]{0,62}"
                      maxLength={63}
                      required
                    />

                    <select
                      aria-label={`Column ${index + 1} type`}
                      value={column.type}
                      onChange={(event) =>
                        updateColumn(index, "type", event.target.value)
                      }
                    >
                      {DB_TYPES.map((type) => (
                        <option value={type} key={type}>
                          {type}
                        </option>
                      ))}
                    </select>

                    <label className="wb-check">
                      <input
                        type="checkbox"
                        checked={column.primaryKey}
                        onChange={(event) => {
                          setNewColumns((current) =>
                            current.map((item, i) => ({
                              ...item,
                              primaryKey: i === index ? event.target.checked : false,
                              nullable: event.target.checked && i === index
                                ? false
                                : item.nullable,
                            }))
                          );
                        }}
                      />
                      Primary key
                    </label>

                    <label className="wb-check">
                      <input
                        type="checkbox"
                        checked={column.nullable}
                        disabled={column.primaryKey}
                        onChange={(event) =>
                          updateColumn(index, "nullable", event.target.checked)
                        }
                      />
                      Nullable
                    </label>

                    <button
                      type="button"
                      className="wb-remove-column"
                      onClick={() => removeColumn(index)}
                      disabled={newColumns.length <= 1}
                      aria-label="Remove column"
                    >
                      ÃƒÆ’Ã¢â‚¬â€
                    </button>
                  </div>
                ))}
              </div>

              <p className="wb-help">
                Supported types: text, integer, bigint, numeric, boolean, date,
                timestamptz, uuid and jsonb. Use one primary key at most.
              </p>

              <div className="pm-form-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setShowTableForm(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-button"
                  disabled={saving}
                >
                  {saving ? "Creating..." : "Create table"}
                </button>
              </div>
            </form>
          ) : selectedTable ? (
            <>
              <div className="wb-toolbar">
                <button
                  className="pm-back"
                  onClick={() => {
                    setSelectedTable(null);
                    setColumns([]);
                    setRows([]);
                    setError("");
                    void loadTables();
                  }}
                >
                  Back to tables
                </button>
                <strong>{selectedTable}</strong>
              </div>

              <article className="panel wb-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Columns</h2>
                    <p>Table structure and data types</p>
                  </div>
                  <div className="wb-record-heading-actions">
  <span className="wb-count">{columns.length} columns</span>
  <select
    value={columnAction}
    onChange={(event) =>
      setColumnAction(event.target.value as "add" | "rename" | "drop")
    }
    disabled={columnSaving}
  >
    <option value="add">Add column</option>
    <option value="rename">Rename column</option>
    <option value="drop">Remove column</option>
  </select>
</div>
                </div>

                <div className="wb-record-heading-actions">
                  {columnAction !== "add" && (
                    <select
                      value={columnName}
                      onChange={(event) => setColumnName(event.target.value)}
                      disabled={columnSaving}
                    >
                      <option value="">Choose column</option>
                      {columns.map((column) => (
                        <option key={column.column_name} value={column.column_name}>
                          {column.column_name}
                        </option>
                      ))}
                    </select>
                  )}

                  {columnAction === "add" && (
                    <input
                      value={columnName}
                      onChange={(event) => setColumnName(event.target.value)}
                      placeholder="New column name"
                      disabled={columnSaving}
                    />
                  )}

                  {columnAction === "add" && (
                    <select
                      value={columnType}
                      onChange={(event) => setColumnType(event.target.value as DbType)}
                      disabled={columnSaving}
                    >
                      {DB_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  )}

                  {columnAction === "rename" && (
                    <input
                      value={newColumnName}
                      onChange={(event) => setNewColumnName(event.target.value)}
                      placeholder="New column name"
                      disabled={columnSaving}
                    />
                  )}

                  <button
                    className="primary-button"
                    onClick={() => void saveColumnChange()}
                    disabled={columnSaving || !columnName.trim()}
                  >
                    {columnSaving ? "SavingÃ¢â‚¬Â¦" : "Apply"}
                  </button>
                </div>

                <div className="wb-table-scroll">
                  <table className="wb-table">
                    <thead>
                      <tr>
                        <th>Column</th>
                        <th>Data type</th>
                        <th>Nullable</th>
                        <th>Default</th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column) => (
                        <tr key={column.column_name}>
                          <td><strong>{column.column_name}</strong></td>
                          <td><code>{column.data_type}</code></td>
                          <td>{column.is_nullable === "YES" ? "Yes" : "No"}</td>
                          <td>{column.column_default || "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <VisualQueryBuilder
                baseUrl={baseUrl}
                tableName={selectedTable}
                columns={columns}
              />

              <article className="panel wb-panel">
                <div className="panel-heading">
                  <div>
                    <h2>Records</h2>
                    <p>Create, edit and manage records in this table.</p>
                  </div>
                  <div className="wb-record-heading-actions">
                    <span className="wb-count">{rowTotal} records</span>
                    {primaryKeyColumn && (
                      <button
                        className="primary-button wb-add-record"
                        onClick={startCreateRecord}
                        disabled={saving}
                      >
                        + Add record
                      </button>
                    )}
                  </div>
                </div>

                <input
                  type="search"
                  value={rowSearch}
                  onChange={(event) => setRowSearch(event.target.value)}
                  placeholder="Search these records..."
                  aria-label="Search records"
                />

                {showRecordForm ? (
                  <form className="wb-record-form" onSubmit={saveRecord}>
                    <div className="wb-record-form-heading">
                      <strong>{editingRow ? "Edit record" : "Create record"}</strong>
                      <span>
                        {editingRow
                          ? "The primary key cannot be changed."
                          : "Enter values for the new record."}
                      </span>
                    </div>

                    <div className="wb-record-fields">
                      {columns.map((column) => {
                        const required =
                          column.is_nullable === "NO" &&
                          !column.column_default &&
                          !(editingRow && column.is_primary_key);

                        const fieldValue =
                          recordValues[column.column_name] ?? "";

                        return (
                          <div className="wb-record-field" key={column.column_name}>
                            <label htmlFor={`record-${column.column_name}`}>
                              {column.column_name}
                              <small>{column.data_type}</small>
                              {column.is_primary_key && (
                                <span className="wb-primary-key-label">PRIMARY KEY</span>
                              )}
                            </label>

                            {column.data_type === "boolean" ? (
                              <select
                                id={`record-${column.column_name}`}
                                value={fieldValue}
                                disabled={Boolean(editingRow && column.is_primary_key)}
                                required={required}
                                onChange={(event) =>
                                  setRecordValues((current) => ({
                                    ...current,
                                    [column.column_name]: event.target.value,
                                  }))
                                }
                              >
                                <option value="">Select value</option>
                                <option value="true">True</option>
                                <option value="false">False</option>
                              </select>
                            ) : column.data_type === "jsonb" ||
                              column.data_type === "json" ? (
                              <textarea
                                id={`record-${column.column_name}`}
                                value={fieldValue}
                                disabled={Boolean(editingRow && column.is_primary_key)}
                                required={required}
                                rows={3}
                                placeholder='{"key": "value"}'
                                onChange={(event) =>
                                  setRecordValues((current) => ({
                                    ...current,
                                    [column.column_name]: event.target.value,
                                  }))
                                }
                              />
                            ) : (
                              <input
                                id={`record-${column.column_name}`}
                                type="text"
                                value={fieldValue}
                                disabled={Boolean(editingRow && column.is_primary_key)}
                                required={required}
                                placeholder={`Enter ${column.column_name}`}
                                onChange={(event) =>
                                  setRecordValues((current) => ({
                                    ...current,
                                    [column.column_name]: event.target.value,
                                  }))
                                }
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="pm-form-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setShowRecordForm(false);
                          setEditingRow(null);
                        }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="primary-button"
                        disabled={saving}
                      >
                        {saving
                          ? "Saving..."
                          : editingRow
                            ? "Save changes"
                            : "Create record"}
                      </button>
                    </div>
                  </form>
                ) : rows.length > 0 ? (
                  <>
                    <div className="wb-table-scroll">
                      <table className="wb-table">
                        <thead>
                          <tr>
                            {columns.map((column) => (
                              <th key={column.column_name}>
                                {column.column_name}
                                {column.is_primary_key ? " ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬Ëœ" : ""}
                              </th>
                            ))}
                            {primaryKeyColumn && <th>Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedRows.map((row, index) => (
                            <tr
                              key={
                                primaryKeyColumn
                                  ? String(row[primaryKeyColumn.column_name])
                                  : index
                              }
                            >
                              {columns.map((column) => (
                                <td key={column.column_name}>
                                  {displayCell(row[column.column_name])}
                                </td>
                              ))}
                              {primaryKeyColumn && (
                                <td>
                                  <div className="wb-row-actions">
                                    <button
                                      onClick={() => startEditRecord(row)}
                                      disabled={saving}
                                    >
                                      Edit
                                    </button>
                                    <button
                                      className="danger"
                                      onClick={() => void deleteRecord(row)}
                                      disabled={saving}
                                    >
                                      Delete
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="wb-pagination">
                      <span>
                        Showing {rowOffset + 1}ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“{rowOffset + rows.length} of {rowTotal}
                      </span>
                      <div className="wb-page-size">
                        <label htmlFor="db-page-size">Rows per page:</label>
                        <select
                          id="db-page-size"
                          value={pageSize}
                          disabled={loading}
                          onChange={(event) => {
                            const nextSize = Number(event.target.value);
                            setPageSize(nextSize);
                            void loadRows(selectedTable, 0, nextSize);
                          }}
                        >
                          <option value={25}>25</option>
                          <option value={50}>50</option>
                          <option value={100}>100</option>
                        </select>
                      </div>
                      <div>
                        <button
                          className="secondary-button"
                          disabled={rowOffset === 0 || loading}
                          onClick={() =>
                            void loadRows(
                              selectedTable,
                              Math.max(0, rowOffset - pageSize)
                            )
                          }
                        >
                          Previous
                        </button>
                        <button
                          className="secondary-button"
                          disabled={rowOffset + rows.length >= rowTotal || loading}
                          onClick={() =>
                            void loadRows(selectedTable, rowOffset + pageSize)
                          }
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="wb-inline-empty">
                    <strong>No records yet</strong>
                    <p>Create the first record in this table.</p>
                    {primaryKeyColumn && (
                      <button
                        className="primary-button"
                        onClick={startCreateRecord}
                      >
                        + Add first record
                      </button>
                    )}
                  </div>
                )}

                {!primaryKeyColumn && (
                  <div className="wb-help">
                    This table has no supported primary key. Record editing and
                    deletion are unavailable until a primary key is added.
                  </div>
                )}
              </article>
            </>
          ) : loading ? (
            <div className="pm-empty panel">
              <div className="pm-spinner" />
              <strong>Loading tables...</strong>
            </div>
          ) : tables.length > 0 ? (
            <div className="pm-project-grid">
              {tables.map((table) => (
                <article className="pm-project-card panel" key={table.table_name}>
                  <div className="pm-card-top">
                    <div className="pm-project-avatar">[table]</div>
                    <span className="pm-status active">table</span>
                  </div>
                  <h3>{table.table_name}</h3>
                  <p className="pm-card-description">
                    PostgreSQL table | {table.column_count} columns
                  </p>
                  <div className="pm-card-footer">
                    <span>Inside {resource.name}</span>
                    <button
                      className="secondary-button"
                      disabled={saving}
                      onClick={() => void renameTable(table.table_name)}
                    >
                      Rename
                    </button>
                    <button onClick={() => void openTable(table.table_name)}>
                      Open table
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="pm-empty panel">
              <div className="pm-empty-icon">[table]</div>
              <h2>No tables yet</h2>
              <p>Create your first table inside this database resource.</p>
              <button
                className="primary-button"
                onClick={() => setShowTableForm(true)}
              >
                <span>+</span> Create your first table
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="wb-upload-panel panel">
            <div>
              <h2>Website files</h2>
              <p>
                Upload static website assets. Maximum 10 MB per file.
              </p>
            </div>
            <label className={`primary-button wb-upload-button ${uploading ? "disabled" : ""}`}>
              {uploading ? "Uploading..." : "+ Upload file"}
              <input
                type="file"
                accept={ALLOWED_FILE_INPUT}
                disabled={uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadFile(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>

          {loading ? (
            <div className="pm-empty panel">
              <div className="pm-spinner" />
              <strong>Loading files...</strong>
            </div>
          ) : files.length > 0 ? (
            <article className="panel wb-panel">
              <div className="panel-heading">
                <div>
                  <h2>Stored files</h2>
                  <p>Private files belonging to this website resource</p>
                </div>
                <span className="wb-count">{files.length} files</span>
              </div>

              <div className="wb-file-list">
                {files.map((file) => (
                  <div className="wb-file-row" key={file.id}>
                    <div className="wb-file-icon">ÃƒÂ¢Ã¢â‚¬â€œÃ‚Â¤</div>
                    <div className="wb-file-info">
                      <strong>{file.original_name}</strong>
                      <small>
                        {file.mime_type} | {formatSize(file.size_bytes)}
                      </small>
                    </div>
                    <div className="wb-file-actions">
                      <button onClick={() => void downloadFile(file)}>
                        Download
                      </button>
                      <button onClick={() => void renameFile(file)}>
                        Rename
                      </button>
                      <button
                        className="danger"
                        onClick={() => void deleteFile(file)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          ) : (
            <div className="pm-empty panel">
              <div className="pm-empty-icon">ÃƒÂ¢Ã¢â‚¬â€œÃ‚Â¤</div>
              <h2>No website files yet</h2>
              <p>
                Upload your HTML, CSS, JavaScript, images and other supported
                static assets.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}













