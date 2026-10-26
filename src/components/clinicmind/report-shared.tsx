import Link from "next/link";
import { Download, Lock } from "lucide-react";
import { Badge, Card } from "@/components/ui/primitives";
import { cn, formatNumber } from "@/lib/utils";

/**
 * Formatting and small building blocks shared by the finance dashboard, the
 * reports and the patient data dashboard. No server imports and no hooks, so
 * server and client components both use it. Money is whole EGP; rates are
 * fractions (0..1) until they are formatted.
 */

export const DASH = "—";

export function fmtCount(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : formatNumber(Math.round(v));
}

export function fmtEgp(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${formatNumber(Math.round(v))} EGP`;
}

/** Compact money for tiles and bars: 1,234,000 → "1.23M EGP"; below 100k the full figure. */
export function fmtEgpShort(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M EGP`;
  if (abs >= 100_000) return `${Math.round(v / 1_000)}k EGP`;
  return fmtEgp(v);
}

/** A fraction as a percentage with one decimal: 0.3456 → "34.6%". */
export function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : `${Math.round(v * 1000) / 10}%`;
}

/** Seconds as people read them: 45 → "45 s", 250 → "4 min 10 s", 7500 → "2 h 5 min". */
export function fmtSeconds(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const s = Math.round(v);
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m} min ${rest} s` : `${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtScore(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? DASH : (Math.round(v * 100) / 100).toFixed(2);
}

export function fmtHours(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return v >= 72 ? `${Math.floor(v / 24)} d` : `${v} h`;
}

/** The headline unit of a metric as a formatter (the metric's stored value: percentages already 0–100 for targets). */
export function fmtUnit(unit: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  switch (unit) {
    case "%":
      return `${Math.round(v * 10) / 10}%`;
    case "s":
      return fmtSeconds(v);
    case "/5":
      return `${fmtScore(v)}/5`;
    default:
      if (unit.startsWith("EGP")) return `${formatNumber(Math.round(v))} ${unit}`;
      return unit ? `${formatNumber(Math.round(v * 10) / 10)} ${unit}` : formatNumber(Math.round(v * 10) / 10);
  }
}

/** The metric id as a small badge ("M4"), naming every block on the reports. */
export function MetricBadge({ id, className }: { id: string; className?: string }) {
  return (
    <Badge tone="accent" className={cn("font-mono", className)}>
      {id}
    </Badge>
  );
}

/** A "CSV" download link (a plain anchor: the browser saves the attachment). */
export function CsvLink({ href, label = "CSV", className }: { href: string; label?: string; className?: string }) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      download
    >
      <Download className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </a>
  );
}

/** A metric block: id badge, title, one-line definition, optional actions, then the content. */
export function MetricBlock({
  id,
  title,
  description,
  action,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("min-w-0 space-y-4 p-4 sm:p-6", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MetricBadge id={id} />
            <h3 className="font-display text-base font-semibold tracking-tight">{title}</h3>
          </div>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </Card>
  );
}

/** "Owner only" in place of revenue figures for roles without finance:read. */
export function OwnerOnly({ what = "Revenue figures" }: { what?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
      <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{what} are owner only.</span>
    </div>
  );
}

/** The short card shown instead of a page to a role that may not see it. */
export function NotForRole({ title, hint }: { title: string; hint: string }) {
  return (
    <Card className="flex flex-col items-start gap-2">
      <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
      <Link href="/dashboard" className="text-sm text-accent underline-offset-2 hover:underline">
        Back to the overview
      </Link>
    </Card>
  );
}

/** Label + value pairs in a compact grid (summary lines under a block title). */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="data-label">{label}</div>
      <div className="font-display text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}
