import { toCsv, type CsvCell } from "./csv";
import type { MetricId } from "./definitions";
import type { Report } from "./service";
import { findTable, reportTables, type Cell, type CellKind } from "./tables";

/** CSV of one metric table (`metric=M4&part=doctor`), exactly the rows the page shows. */
export function metricCsv(report: Report, metric: MetricId, part?: string): { filename: string; csv: string } | null {
  const table = findTable(reportTables(report), metric, part);
  if (!table) return null;
  const headers = table.columns.map((c) => (c.kind === "percent" ? `${c.label} (%)` : c.kind === "egp" ? `${c.label} (EGP)` : c.kind === "seconds" ? `${c.label} (s)` : c.kind === "hours" ? `${c.label} (h)` : c.label));
  const rows = table.rows.map((r) => r.cells.map((cell, i) => csvCell(cell, table.columns[i]?.kind)));
  return {
    filename: `${metric}-${table.part}-${report.period.fromKey}-to-${report.period.toKey}.csv`,
    csv: toCsv(headers, rows),
  };
}

function csvCell(cell: Cell, kind?: CellKind): CsvCell {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === "number") {
    if (kind === "percent") return Math.round(cell * 1000) / 10;
    if (kind === "score") return Math.round(cell * 100) / 100;
    return Math.round(cell);
  }
  return cell;
}
