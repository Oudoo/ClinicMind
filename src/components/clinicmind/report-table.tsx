import { formatDateInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { Cell, CellKind, TableSpec } from "@/modules/reporting/tables";
import { CsvLink, DASH, MetricBadge, fmtCount, fmtEgp, fmtHours, fmtPct, fmtScore, fmtSeconds } from "./report-shared";

/**
 * One metric table exactly as the CSV export writes it (the same TableSpec):
 * the metric id, the title, the columns with their phone/tablet hiding, the
 * signed-in doctor's own row highlighted, and a CSV link.
 */
export function ReportTable({
  table,
  exportHref,
  timezone,
  highlightKey,
  emptyText = "No data in this period.",
  bare = false,
  limit,
}: {
  table: TableSpec;
  exportHref: string;
  timezone: string;
  /** Row key to highlight (the signed-in user's own row). */
  highlightKey?: string | null;
  emptyText?: string;
  /** Without the outer border (inside a MetricBlock that already frames it). */
  bare?: boolean;
  /** Show only the first n rows (the CSV still has all of them). */
  limit?: number;
}) {
  const rows = limit ? table.rows.slice(0, limit) : table.rows;
  const hideClass = (hide?: "md" | "lg") => (hide === "md" ? "hidden md:table-cell" : hide === "lg" ? "hidden lg:table-cell" : undefined);
  return (
    <section aria-label={`${table.metric} ${table.title}`} className={cn("min-w-0 space-y-2", !bare && "rounded-lg border border-border p-3 sm:p-4")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MetricBadge id={table.metric} />
            <h4 className="text-sm font-semibold">{table.title}</h4>
          </div>
          {table.description ? <p className="mt-0.5 text-xs text-muted-foreground">{table.description}</p> : null}
        </div>
        <CsvLink href={exportHref} />
      </div>
      {rows.length ? (
        <div className="-mx-3 sm:-mx-4">
          <Table className="relative text-[13px]">
            <THead>
              <TR className="hover:bg-transparent">
                {table.columns.map((c, i) => (
                  <TH key={c.label + i} className={cn("py-2", numeric(c.kind) && i > 0 && "text-right", hideClass(c.hide))}>
                    {c.label}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {rows.map((r, ri) => {
                const mine = Boolean(highlightKey && r.key === highlightKey);
                return (
                  <TR key={(r.key ?? "") + ri} className={mine ? "bg-accent-muted/50 hover:bg-accent-muted/60" : undefined} aria-current={mine ? "true" : undefined}>
                    {r.cells.map((cell, ci) => {
                      const col = table.columns[ci];
                      return (
                        <TD
                          key={ci}
                          className={cn(
                            "py-2",
                            ci === 0 ? "font-medium" : "whitespace-nowrap",
                            numeric(col?.kind) && ci > 0 && "text-right font-mono tabular-nums",
                            hideClass(col?.hide),
                          )}
                        >
                          {formatCell(cell, col?.kind, timezone)}
                          {ci === 0 && mine ? <span className="ml-2 text-xs font-normal text-accent">you</span> : null}
                        </TD>
                      );
                    })}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{emptyText}</p>
      )}
      {limit && table.rows.length > limit ? (
        <p className="text-xs text-muted-foreground">
          Showing {limit} of {table.rows.length}; the CSV has every row.
        </p>
      ) : null}
      {table.note ? <p className="text-xs text-muted-foreground">{table.note}</p> : null}
    </section>
  );
}

const numeric = (kind?: CellKind) => kind !== undefined && kind !== "text" && kind !== "date";

export function formatCell(cell: Cell, kind: CellKind | undefined, timezone: string): string {
  if (cell === null || cell === undefined) return DASH;
  if (typeof cell === "string") return cell;
  if (cell instanceof Date) return formatDateInTz(cell, timezone);
  switch (kind) {
    case "egp":
      return fmtEgp(cell);
    case "percent":
      return fmtPct(cell);
    case "seconds":
      return fmtSeconds(cell);
    case "score":
      return fmtScore(cell);
    case "hours":
      return fmtHours(cell);
    default:
      return fmtCount(cell);
  }
}
