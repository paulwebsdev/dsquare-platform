import { useState } from "react";
import "./VisualQueryBuilder.css";

type QueryColumn = {
  column_name: string;
  data_type: string;
};

type FilterOperator =
  | "eq"
  | "neq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isNull"
  | "isNotNull";

type FilterRow = {
  id: number;
  column: string;
  operator: FilterOperator;
  value: string;
};

type Props = {
  baseUrl: string;
  tableName: string;
  columns: QueryColumn[];
};

const operators: { value: FilterOperator; label: string }[] = [
  { value: "eq", label: "Equals" },
  { value: "neq", label: "Does not equal" },
  { value: "contains", label: "Contains" },
  { value: "startsWith", label: "Starts with" },
  { value: "endsWith", label: "Ends with" },
  { value: "gt", label: "Greater than" },
  { value: "gte", label: "Greater than or equal" },
  { value: "lt", label: "Less than" },
  { value: "lte", label: "Less than or equal" },
  { value: "isNull", label: "Is empty (NULL)" },
  { value: "isNotNull", label: "Is not empty" },
];

export default function VisualQueryBuilder({
  baseUrl,
  tableName,
  columns,
}: Props) {
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [logic, setLogic] = useState<"AND" | "OR">("AND");
  const [sortColumn, setSortColumn] = useState("");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const pageSize = 10;
  const page = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const addFilter = () => {
    if (filters.length >= 10 || columns.length === 0) return;

    setFilters((current) => [
      ...current,
      {
        id: Date.now() + current.length,
        column: columns[0].column_name,
        operator: "eq",
        value: "",
      },
    ]);
  };

  const updateFilter = (
    id: number,
    field: keyof Omit<FilterRow, "id">,
    value: string
  ) => {
    setFilters((current) =>
      current.map((filter) =>
        filter.id === id ? { ...filter, [field]: value } : filter
      )
    );
  };

  const runQuery = async (nextOffset = 0) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `${baseUrl}/tables/${encodeURIComponent(tableName)}/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filters: filters.map(({ column, operator, value }) => ({
              column,
              operator,
              ...(operator === "isNull" || operator === "isNotNull"
                ? {}
                : { value }),
            })),
            logic,
            ...(sortColumn
              ? { sort: { column: sortColumn, direction: sortDirection } }
              : {}),
            limit: pageSize,
            offset: nextOffset,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Unable to run this query.");
      }

      setRows(result.rows || []);
      setTotal(Number(result.total || 0));
      setOffset(nextOffset);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong."
      );
    } finally {
      setLoading(false);
    }
  };

  const removeFilter = (id: number) => {
    setFilters((current) => current.filter((filter) => filter.id !== id));
  };

  return (
    <section className="vqb-container">
      <div className="vqb-heading">
        <div>
          <h2>Visual Query Builder</h2>
          <p>Filter, sort and explore your table without writing SQL.</p>
        </div>
        <span className="vqb-table-label">{tableName}</span>
      </div>

      <div className="vqb-section">
        <div className="vqb-section-heading">
          <h3>Conditions</h3>
          <button
            type="button"
            className="vqb-secondary-button"
            onClick={addFilter}
            disabled={filters.length >= 10 || columns.length === 0}
          >
            + Add condition
          </button>
        </div>

        {filters.length > 1 && (
          <div className="vqb-logic">
            <span>Match</span>
            <select
              value={logic}
              onChange={(event) =>
                setLogic(event.target.value as "AND" | "OR")
              }
            >
              <option value="AND">ALL conditions (AND)</option>
              <option value="OR">ANY condition (OR)</option>
            </select>
          </div>
        )}

        {filters.length === 0 && (
          <p className="vqb-muted">
            No conditions added. The query will return all rows.
          </p>
        )}

        {filters.map((filter, index) => (
          <div className="vqb-filter-row" key={filter.id}>
            <span className="vqb-filter-number">{index + 1}</span>

            <select
              aria-label="Column"
              value={filter.column}
              onChange={(event) =>
                updateFilter(filter.id, "column", event.target.value)
              }
            >
              {columns.map((column) => (
                <option key={column.column_name} value={column.column_name}>
                  {column.column_name}
                </option>
              ))}
            </select>

            <select
              aria-label="Condition"
              value={filter.operator}
              onChange={(event) =>
                updateFilter(
                  filter.id,
                  "operator",
                  event.target.value
                )
              }
            >
              {operators.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>

            {filter.operator !== "isNull" &&
            filter.operator !== "isNotNull" ? (
              <input
                aria-label="Value"
                value={filter.value}
                onChange={(event) =>
                  updateFilter(filter.id, "value", event.target.value)
                }
                placeholder="Enter a value"
              />
            ) : (
              <span className="vqb-muted">No value needed</span>
            )}

            <button
              type="button"
              className="vqb-remove-button"
              onClick={() => removeFilter(filter.id)}
              aria-label="Remove condition"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="vqb-section">
        <h3>Sorting</h3>
        <div className="vqb-sort-row">
          <select
            aria-label="Sort column"
            value={sortColumn}
            onChange={(event) => setSortColumn(event.target.value)}
          >
            <option value="">No sorting</option>
            {columns.map((column) => (
              <option key={column.column_name} value={column.column_name}>
                {column.column_name}
              </option>
            ))}
          </select>

          <select
            aria-label="Sort direction"
            value={sortDirection}
            onChange={(event) =>
              setSortDirection(event.target.value as "asc" | "desc")
            }
            disabled={!sortColumn}
          >
            <option value="asc">Ascending (A–Z / low–high)</option>
            <option value="desc">Descending (Z–A / high–low)</option>
          </select>
        </div>
      </div>

      <div className="vqb-actions">
        <button
          type="button"
          className="vqb-run-button"
          onClick={() => runQuery(0)}
          disabled={loading}
        >
          {loading ? "Running..." : "Run query"}
        </button>
        <span className="vqb-muted">Maximum 10 conditions per query</span>
      </div>

      {error && <p className="vqb-error">{error}</p>}

      <div className="vqb-results">
        <div className="vqb-results-heading">
          <h3>Query results</h3>
          <span>{total.toLocaleString()} records</span>
        </div>

        {rows.length === 0 && !loading ? (
          <p className="vqb-muted">
            Run a query to see matching records.
          </p>
        ) : (
          <div className="vqb-table-scroll">
            <table className="vqb-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.column_name}>{column.column_name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => {
                      const value = row[column.column_name];
                      return (
                        <td key={column.column_name}>
                          {value === null || value === undefined
                            ? <span className="vqb-null">NULL</span>
                            : String(value)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="vqb-pagination">
          <button
            type="button"
            className="vqb-secondary-button"
            disabled={loading || offset === 0 || total === 0}
            onClick={() => runQuery(Math.max(0, offset - pageSize))}
          >
            Previous
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            type="button"
            className="vqb-secondary-button"
            disabled={loading || offset + pageSize >= total}
            onClick={() => runQuery(offset + pageSize)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
