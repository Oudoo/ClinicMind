"use client";

import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn, formatNumber } from "@/lib/utils";

export interface CompareFigure {
  key: string;
  label: string;
  value: number;
}

const egp = (v: number) => (v < 0 ? `−${formatNumber(-v)}` : formatNumber(v));
const parse = (s: string) => {
  const t = s.replace(/[,\s]/g, "").replace(/^[−–]/, "-");
  return t === "" || !/^-?\d+$/.test(t) ? null : Number(t);
};

/**
 * Type Dentalore's totals for the same day beside ClinicMind's and see the
 * difference on each line: the check that a day closes the same in both
 * while the two run side by side. Nothing is stored.
 */
export function DentaloreCompare({ figures }: { figures: CompareFigure[] }) {
  const id = useId();
  const [theirs, setTheirs] = useState<Record<string, string>>({});
  const entered = figures.filter((f) => parse(theirs[f.key] ?? "") !== null);
  const same = entered.length > 0 && entered.every((f) => parse(theirs[f.key] ?? "") === f.value);
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-label="Compare with Dentalore">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 pe-3 text-start font-normal">The day</th>
              <th className="py-2 pe-3 text-end font-normal">ClinicMind</th>
              <th className="py-2 pe-3 text-end font-normal">Dentalore</th>
              <th className="py-2 text-end font-normal">Difference</th>
            </tr>
          </thead>
          <tbody>
            {figures.map((f) => {
              const value = parse(theirs[f.key] ?? "");
              const diff = value === null ? null : f.value - value;
              return (
                <tr key={f.key} className="border-b border-border/60">
                  <td className="py-2 pe-3">
                    <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
                  </td>
                  <td className="py-2 pe-3 text-end font-mono tabular-nums">{egp(f.value)}</td>
                  <td className="py-2 pe-3">
                    <Input id={`${id}-${f.key}`} inputMode="numeric" value={theirs[f.key] ?? ""} onChange={(e) => setTheirs((t) => ({ ...t, [f.key]: e.target.value }))} placeholder="—" className="ms-auto h-9 w-28 text-end font-mono" />
                  </td>
                  <td className={cn("py-2 text-end font-mono tabular-nums", diff !== null && diff !== 0 && "text-danger", diff === 0 && "text-success")}>
                    {diff === null ? "" : diff === 0 ? "same" : diff > 0 ? `+${egp(diff)}` : egp(diff)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={cn("text-sm", same ? "text-success" : "text-muted-foreground")} role="status">
        {same ? (
          <span className="inline-flex items-center gap-1.5">
            <Check className="h-4 w-4" aria-hidden="true" />
            The {entered.length === figures.length ? "day closes" : `${entered.length} figures entered close`} to the same totals in both.
          </span>
        ) : entered.length ? (
          "A difference: open the receipts below, or Daily adjustments, to find it."
        ) : (
          "Type Dentalore's totals for the same day and branch to compare."
        )}
      </p>
    </div>
  );
}
