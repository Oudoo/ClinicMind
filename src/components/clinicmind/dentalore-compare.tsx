"use client";

import { useId, useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
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
 * while the two run side by side. Nothing is stored. Rendered edge to edge
 * inside a `Card className="overflow-hidden p-0"` under its heading.
 */
export function DentaloreCompare({ figures }: { figures: CompareFigure[] }) {
  const id = useId();
  const [theirs, setTheirs] = useState<Record<string, string>>({});
  const entered = figures.filter((f) => parse(theirs[f.key] ?? "") !== null);
  const same = entered.length > 0 && entered.every((f) => parse(theirs[f.key] ?? "") === f.value);
  return (
    <>
      <Table aria-label="Compare with Dentalore">
        <THead>
          <TR className="hover:bg-transparent">
            <TH>The day</TH>
            <TH className="text-right">ClinicMind</TH>
            <TH className="text-right">Dentalore</TH>
            <TH className="text-right">Difference</TH>
          </TR>
        </THead>
        <TBody>
          {figures.map((f) => {
            const value = parse(theirs[f.key] ?? "");
            const diff = value === null ? null : f.value - value;
            return (
              <TR key={f.key}>
                <TD className="py-2">
                  <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
                </TD>
                <TD className="py-2 text-right tabular-nums">{egp(f.value)}</TD>
                <TD className="py-2">
                  <Input
                    id={`${id}-${f.key}`}
                    inputMode="numeric"
                    value={theirs[f.key] ?? ""}
                    onChange={(e) => setTheirs((t) => ({ ...t, [f.key]: e.target.value }))}
                    placeholder="—"
                    aria-label={`Dentalore's ${f.label}`}
                    className="ms-auto h-9 w-28 text-right tabular-nums"
                  />
                </TD>
                <TD className={cn("py-2 text-right text-xs tabular-nums", diff !== null && diff !== 0 && "text-danger", diff === 0 && "text-success")}>
                  {diff === null ? "" : diff === 0 ? "Same" : diff > 0 ? `+${egp(diff)}` : egp(diff)}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
      <p className={cn("border-t border-border px-5 py-4 text-sm", same ? "text-success" : "text-muted-foreground")} role="status">
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
    </>
  );
}
