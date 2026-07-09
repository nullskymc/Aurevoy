import { useMemo, useState } from "react";
import type { GenerativeUiComponentProps } from "../registry";

export type DataTableProps = {
  title?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  features?: string[];
};

type SortState = { col: number; dir: "asc" | "desc" } | null;

export function DataTableCard({
  data,
}: GenerativeUiComponentProps & { data: DataTableProps }) {
  const features = new Set(data.features ?? ["sort", "copy"]);
  const [sort, setSort] = useState<SortState>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || !features.has("filter")) return data.rows;
    return data.rows.filter((row) =>
      row.some((cell) => String(cell ?? "").toLowerCase().includes(q)),
    );
  }, [data.rows, filter, features]);

  const sorted = useMemo(() => {
    if (!sort || !features.has("sort")) return filtered;
    const { col, dir } = sort;
    const next = filtered.slice();
    next.sort((a, b) => compareCells(a[col], b[col]) * (dir === "asc" ? 1 : -1));
    return next;
  }, [filtered, sort, features]);

  const sums = useMemo(() => {
    if (!features.has("sum")) return null;
    return data.columns.map((_, ci) => {
      let total = 0;
      let count = 0;
      for (const row of sorted) {
        const v = row[ci];
        if (typeof v === "number" && Number.isFinite(v)) {
          total += v;
          count += 1;
        } else if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
          total += Number(v);
          count += 1;
        }
      }
      return count > 0 ? total : null;
    });
  }, [sorted, data.columns, features]);

  function toggleSort(col: number): void {
    if (!features.has("sort")) return;
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return null;
    });
  }

  async function copyTsv(): Promise<void> {
    const lines = [
      data.columns.join("\t"),
      ...sorted.map((row) => row.map((c) => (c == null ? "" : String(c))).join("\t")),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="gen-ui-card gen-ui-table-card">
      <header className="gen-ui-card-head">
        <strong>{data.title || "数据表"}</strong>
        <span className="gen-ui-card-meta">
          {sorted.length}/{data.rows.length} 行
        </span>
        <div className="gen-ui-card-actions">
          {features.has("filter") && (
            <input
              className="gen-ui-filter"
              type="search"
              placeholder="筛选…"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              aria-label="筛选表格"
            />
          )}
          {features.has("copy") && (
            <button type="button" className="gen-ui-btn" onClick={() => void copyTsv()}>
              {copied ? "已复制" : "复制"}
            </button>
          )}
        </div>
      </header>
      <div className="gen-ui-table-wrap">
        <table className="gen-ui-table">
          <thead>
            <tr>
              {data.columns.map((col, ci) => (
                <th key={`${col}-${ci}`}>
                  {features.has("sort") ? (
                    <button
                      type="button"
                      className="gen-ui-th-btn"
                      onClick={() => toggleSort(ci)}
                      data-sorted={sort?.col === ci ? sort.dir : undefined}
                    >
                      {col}
                      {sort?.col === ci ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  ) : (
                    col
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={data.columns.length} className="gen-ui-table-empty">
                  无匹配行
                </td>
              </tr>
            ) : (
              sorted.map((row, ri) => (
                <tr key={ri}>
                  {data.columns.map((_, ci) => (
                    <td key={ci}>{formatCell(row[ci])}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {sums && sums.some((s) => s != null) && (
            <tfoot>
              <tr>
                {sums.map((s, ci) => (
                  <td key={ci} className="gen-ui-table-sum">
                    {s == null ? "" : typeof s === "number" ? formatNumber(s) : s}
                    {ci === 0 && s == null ? "合计" : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function compareCells(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") {
    return na - nb;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function formatCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") return formatNumber(value);
  return String(value);
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
