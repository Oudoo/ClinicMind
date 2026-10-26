"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { MetricBadge, fmtUnit } from "./report-shared";

export interface TargetRowDTO {
  metric: string;
  name: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  current: number | null;
  /** YYYY-MM-DD */
  dueAt: string | null;
  goodWhen: "up" | "down";
  onTrack: boolean | null;
  finance: boolean;
}

/**
 * The success-metrics table: baseline, target and due date per metric next to
 * the current value for the chosen period. The owner edits a row in place.
 */
export function ReportTargets({ rows, canEdit, redacted, periodLabel }: { rows: TargetRowDTO[]; canEdit: boolean; redacted: boolean; periodLabel: string }) {
  const [editing, setEditing] = useState<TargetRowDTO | null>(null);
  return (
    <>
      <div className="-mx-4 sm:-mx-6">
        <Table className="relative text-[13px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Metric</TH>
              <TH className="hidden text-right md:table-cell">Baseline</TH>
              <TH className="text-right">Target</TH>
              <TH className="text-right">Now</TH>
              <TH className="hidden lg:table-cell">Due</TH>
              {canEdit ? (
                <TH className="w-10">
                  <span className="sr-only">Edit</span>
                </TH>
              ) : null}
            </TR>
          </THead>
          <TBody>
            {rows.map((r) => {
              const hidden = r.finance && redacted;
              return (
                <TR key={r.metric}>
                  <TD>
                    <div className="flex items-center gap-2">
                      <MetricBadge id={r.metric} />
                      <span className="font-medium">{r.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{r.goodWhen === "up" ? "Higher is better" : "Lower is better"}</div>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-right font-mono tabular-nums md:table-cell">{hidden ? "owner only" : fmtUnit(r.unit, r.baseline)}</TD>
                  <TD className="whitespace-nowrap text-right font-mono tabular-nums">{hidden ? "owner only" : fmtUnit(r.unit, r.target)}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <div className="font-mono tabular-nums">{hidden ? "—" : fmtUnit(r.unit, r.current)}</div>
                    {r.onTrack === null ? null : r.onTrack ? <Badge tone="success">on track</Badge> : <Badge tone="warning">off track</Badge>}
                  </TD>
                  <TD className="hidden whitespace-nowrap font-mono text-xs lg:table-cell">{r.dueAt ?? "—"}</TD>
                  {canEdit ? (
                    <TD>
                      <Button type="button" size="icon" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit the target for ${r.metric}`}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">“Now” is the headline value for {periodLabel}; counts are per period, so compare them with a 28-day period.</p>
      {editing ? <TargetDialog row={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function TargetDialog({ row, onClose }: { row: TargetRowDTO; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [baseline, setBaseline] = useState(row.baseline === null ? "" : String(row.baseline));
  const [target, setTarget] = useState(row.target === null ? "" : String(row.target));
  const [unit, setUnit] = useState(row.unit);
  const [dueAt, setDueAt] = useState(row.dueAt ?? "");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const num = (s: string) => (s.trim() === "" ? null : Number(s.replace(/[,\s]/g, "")));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const b = num(baseline);
    const t = num(target);
    const next: Record<string, string> = {};
    if (b !== null && !Number.isFinite(b)) next.baseline = "A number, or empty.";
    if (t !== null && !Number.isFinite(t)) next.target = "A number, or empty.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/reports/targets", { method: "PUT", body: { metric: row.metric, baseline: b, target: t, unit: unit.trim() || null, dueAt: dueAt || null } });
      toast({ tone: "success", title: `Target saved for ${row.metric}` });
      onClose();
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const issue = (k: string) => (issues[k] ? <span className="text-danger">{issues[k]}</span> : undefined);
  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent title={`${row.metric} · ${row.name}`} description={row.goodWhen === "up" ? "Higher is better." : "Lower is better."}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Baseline" htmlFor={`${id}-baseline`} hint={issue("baseline")}>
              <Input id={`${id}-baseline`} inputMode="decimal" value={baseline} onChange={(e) => setBaseline(e.target.value)} />
            </Field>
            <Field label="Target" htmlFor={`${id}-target`} hint={issue("target")}>
              <Input id={`${id}-target`} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
            </Field>
            <Field label="Unit" htmlFor={`${id}-unit`} hint={issue("unit") ?? "e.g. %, s, EGP/28 d"}>
              <DictationField multiline={false} onDictated={setUnit} disabled={busy}>
                <Input id={`${id}-unit`} value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} />
              </DictationField>
            </Field>
            <Field label="Due" htmlFor={`${id}-due`} hint={issue("dueAt")}>
              <Input id={`${id}-due`} type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save target"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
