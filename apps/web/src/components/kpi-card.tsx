import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * KPI stat card with period-over-period delta and a source-trace tooltip —
 * the Verifiable Data Layer surfaces here as `sourceHint`.
 */
export function KpiCard({
  label,
  value,
  delta,
  invertDelta = false,
  sourceHint,
}: {
  label: string;
  value: string;
  delta?: number | null;
  /** For cost metrics where down = good */
  invertDelta?: boolean;
  sourceHint?: string;
}) {
  const good = delta === null || delta === undefined ? null : invertDelta ? delta < 0 : delta > 0;
  return (
    <Card title={sourceHint}>
      <CardContent className="p-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 flex items-end justify-between">
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
          {delta !== undefined && delta !== null && (
            <div
              className={cn(
                "flex items-center gap-0.5 text-sm font-medium",
                good === null ? "text-muted-foreground" : good ? "text-emerald-600" : "text-red-600"
              )}
            >
              {Math.abs(delta) < 0.05 ? (
                <Minus className="h-4 w-4" />
              ) : delta > 0 ? (
                <ArrowUpRight className="h-4 w-4" />
              ) : (
                <ArrowDownRight className="h-4 w-4" />
              )}
              {Math.abs(delta).toFixed(1)}%
            </div>
          )}
        </div>
        {sourceHint && (
          <div className="mt-2 text-[11px] text-muted-foreground truncate">⛓ {sourceHint}</div>
        )}
      </CardContent>
    </Card>
  );
}
