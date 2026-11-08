import { useEffect, useState } from "react";

type ColumnOption = { column_name: string };
type IndexItem = { indexname: string; indexdef: string };
type ConstraintItem = { name: string; type: string; definition: string };

type Props = {
  baseUrl: string;
  tableName: string;
  columns: ColumnOption[];
};

export default function TableStructureManager({ baseUrl, tableName, columns }: Props) {
  const [indexes, setIndexes] = useState<IndexItem[]>([]);
  const [constraints, setConstraints] = useState<ConstraintItem[]>([]);
  const [indexName, setIndexName] = useState("");
  const [indexColumns, setIndexColumns] = useState("");
  const [uniqueIndex, setUniqueIndex] = useState(false);
  const [constraintName, setConstraintName] = useState("");
  const [constraintType, setConstraintType] = useState<"unique" | "foreign_key">("unique");
  const [constraintColumns, setConstraintColumns] = useState("");
  const [sourceColumn, setSourceColumn] = useState(columns[0]?.column_name || "");
  const [referencedTable, setReferencedTable] = useState("");
  const [referencedColumn, setReferencedColumn] = useState("");
  const [onDelete, setOnDelete] = useState("NO ACTION");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function loadStructure() {
    try {
      const response = await fetch(`${baseUrl}/tables/${encodeURIComponent(tableName)}/structure`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load indexes and constraints.");
      setIndexes(data.indexes || []);
      setConstraints(data.constraints || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load table structure.");
    }
  }

  useEffect(() => {
    void loadStructure();
  }, [baseUrl, tableName]);

  useEffect(() => {
    if (!columns.some(column => column.column_name === sourceColumn)) {
      setSourceColumn(columns[0]?.column_name || "");
    }
  }, [columns, sourceColumn]);

  async function send(path: string, method: string, body?: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "The table-structure operation failed.");
    return data;
  }

  async function createIndex() {
    const parsedColumns = indexColumns.split(",").map(value => value.trim()).filter(Boolean);
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await send(`/tables/${encodeURIComponent(tableName)}/indexes`, "POST", {
        name: indexName.trim(), columns: parsedColumns, unique: uniqueIndex,
      });
      setMessage(result.message);
      setIndexName(""); setIndexColumns(""); setUniqueIndex(false);
      await loadStructure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create index.");
    } finally { setSaving(false); }
  }

  async function createConstraint() {
    setSaving(true); setError(""); setMessage("");
    try {
      const body = constraintType === "unique"
        ? { type: "unique", name: constraintName.trim(), columns: constraintColumns.split(",").map(value => value.trim()).filter(Boolean) }
        : { type: "foreign_key", name: constraintName.trim(), column: sourceColumn, referencedTable: referencedTable.trim(), referencedColumn: referencedColumn.trim(), onDelete };
      const result = await send(`/tables/${encodeURIComponent(tableName)}/constraints`, "POST", body);
      setMessage(result.message);
      setConstraintName(""); setConstraintColumns(""); setReferencedTable(""); setReferencedColumn("");
      await loadStructure();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create constraint.");
    } finally { setSaving(false); }
  }

  async function remove(path: string, label: string) {
    if (!window.confirm(`Delete this ${label}? This may affect how your data is validated or queried.`)) return;
    setSaving(true); setError(""); setMessage("");
    try {
      const result = await send(path, "DELETE");
      setMessage(result.message);
      await loadStructure();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not delete ${label}.`);
    } finally { setSaving(false); }
  }

  return (
    <article className="panel wb-panel">
      <div className="panel-heading">
        <div>
          <h2>Indexes &amp; constraints</h2>
          <p>Improve query performance and enforce relational data integrity.</p>
        </div>
        <span className="wb-count">{indexes.length} indexes · {constraints.length} constraints</span>
      </div>

      {error && <div className="wb-help" role="alert">{error}</div>}
      {message && <div className="wb-help" role="status">{message}</div>}

      <div className="wb-record-form">
        <strong>Create an index</strong>
        <p className="wb-help">Indexes can speed up searches and sorting. Use comma-separated column names for a multi-column index.</p>
        <div className="wb-record-fields">
          <label>Index name<input value={indexName} onChange={event => setIndexName(event.target.value)} placeholder="idx_orders_customer" /></label>
          <label>Columns<input value={indexColumns} onChange={event => setIndexColumns(event.target.value)} placeholder="customer_id, created_at" /></label>
          <label className="wb-record-field"><span><input type="checkbox" checked={uniqueIndex} onChange={event => setUniqueIndex(event.target.checked)} /> Unique index</span></label>
        </div>
        <button className="primary-button" disabled={saving || !indexName.trim() || !indexColumns.trim()} onClick={() => void createIndex()}>
          {saving ? "Saving..." : "Create index"}
        </button>
      </div>

      <div className="wb-record-form">
        <strong>Create a constraint</strong>
        <div className="wb-record-heading-actions">
          <select value={constraintType} onChange={event => setConstraintType(event.target.value as "unique" | "foreign_key")}>
            <option value="unique">Unique constraint</option>
            <option value="foreign_key">Foreign key</option>
          </select>
          <input value={constraintName} onChange={event => setConstraintName(event.target.value)} placeholder="constraint_name" />
        </div>
        {constraintType === "unique" ? (
          <label>Columns<input value={constraintColumns} onChange={event => setConstraintColumns(event.target.value)} placeholder="email or tenant_id, email" /></label>
        ) : (
          <div className="wb-record-fields">
            <label>Source column<select value={sourceColumn} onChange={event => setSourceColumn(event.target.value)}>{columns.map(column => <option key={column.column_name} value={column.column_name}>{column.column_name}</option>)}</select></label>
            <label>Referenced table<input value={referencedTable} onChange={event => setReferencedTable(event.target.value)} placeholder="customers" /></label>
            <label>Referenced column<input value={referencedColumn} onChange={event => setReferencedColumn(event.target.value)} placeholder="id" /></label>
            <label>On delete<select value={onDelete} onChange={event => setOnDelete(event.target.value)}><option>NO ACTION</option><option>RESTRICT</option><option>CASCADE</option><option>SET NULL</option></select></label>
          </div>
        )}
        <button className="primary-button" disabled={saving || !constraintName.trim() || (constraintType === "unique" ? !constraintColumns.trim() : !sourceColumn || !referencedTable.trim() || !referencedColumn.trim())} onClick={() => void createConstraint()}>
          {saving ? "Saving..." : "Add constraint"}
        </button>
        <p className="wb-help">Foreign keys can reference tables only within this database resource. The referenced column must be primary-key or unique.</p>
      </div>

      <div className="wb-table-scroll">
        <h3>Indexes</h3>
        {indexes.length ? indexes.map(index => (
          <div className="wb-file-row" key={index.indexname}>
            <div className="wb-file-info"><strong>{index.indexname}</strong><small><code>{index.indexdef}</code></small></div>
            <button className="danger" disabled={saving || index.indexdef.includes("PRIMARY KEY") || constraints.some(item => item.name === index.indexname)} onClick={() => void remove(`/tables/${encodeURIComponent(tableName)}/indexes/${encodeURIComponent(index.indexname)}`, "index")}>Delete</button>
          </div>
        )) : <p className="wb-help">No indexes found.</p>}
      </div>

      <div className="wb-table-scroll">
        <h3>Constraints</h3>
        {constraints.length ? constraints.map(item => (
          <div className="wb-file-row" key={item.name}>
            <div className="wb-file-info"><strong>{item.name} · {item.type.replace("_", " ")}</strong><small><code>{item.definition}</code></small></div>
            <button className="danger" disabled={saving || item.type === "primary_key"} onClick={() => void remove(`/tables/${encodeURIComponent(tableName)}/constraints/${encodeURIComponent(item.name)}`, "constraint")}>Delete</button>
          </div>
        )) : <p className="wb-help">No constraints found.</p>}
      </div>
    </article>
  );
}
