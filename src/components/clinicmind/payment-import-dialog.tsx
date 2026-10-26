"use client";

import { useId, useState, type ChangeEvent } from "react";
import { CheckCircle2, FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatDateTimeInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import type { ImportPreview, ImportPreviewRow } from "@/modules/finance/imports";
import { financeErrorMessage } from "./finance-shared";

const SAMPLE = `date,phone,amount,kind,method,reference,name
2026-10-25 14:10,01012345678,2500,payment,card,POS-88812,Sara Adel
25/10/2026 15:30,٠١٠٠١٢٣٤٥٦٧,600,consultation,cash,RCPT-5531,`;

/**
 * Import the day's POS / card-terminal export: paste the CSV or choose the
 * file, preview every row with the patient matched by phone (Arabic digits
 * read) and its problems, then import the ready rows as payments under one
 * batch. Nothing is written before "Import".
 */
export function ImportPosDialog({ timezone, onOpenChange, onDone }: { timezone: string; onOpenChange: (open: boolean) => void; onDone: (created: number, skipped: number) => void }) {
  const id = useId();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("The file is too large (1 MB max).");
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
    setPreview(null);
    setError(null);
  }

  async function runPreview() {
    if (!csv.trim()) {
      setError("Paste the CSV or choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await apiFetch<ImportPreview>("/api/payments/import", { method: "POST", body: { csv } }));
    } catch (err) {
      const fields = fieldErrors(err);
      setError(fields.csv ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const ready = preview?.rows.filter((r) => r.ok) ?? [];

  async function confirm() {
    if (!ready.length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ importBatchId: string; created: number; skipped: number }>("/api/payments/import/confirm", {
        method: "POST",
        body: {
          rows: ready.map((r) => ({
            patientId: r.patient!.id,
            paidAt: r.paidAt!,
            amount: r.amount!,
            kind: r.kind,
            method: r.method,
            reference: r.reference ?? undefined,
            note: fileName ? `POS import · ${fileName}` : "POS import",
          })),
        },
      });
      onDone(res.created, res.skipped);
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Import a POS export" description="Paste the CSV or choose the file. Rows are matched to patients by phone; nothing is saved until you import." className="max-w-3xl">
        <div className="space-y-4">
          {error ? <Alert>{error}</Alert> : null}
          {!preview ? (
            <>
              <Field
                label="CSV"
                htmlFor={`${id}-csv`}
                hint={
                  <>
                    Columns: <span className="font-mono">date, phone, amount</span> and optionally <span className="font-mono">kind, method, reference, name</span>. Dates as
                    2026-10-25 14:10 or 25/10/2026; Arabic digits are fine.
                  </>
                }
              >
                <Textarea
                  id={`${id}-csv`}
                  value={csv}
                  onChange={(e) => {
                    setCsv(e.target.value);
                    setFileName(null);
                  }}
                  placeholder={SAMPLE}
                  className="min-h-[9rem] font-mono text-xs"
                  spellCheck={false}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted">
                  <FileUp className="h-4 w-4" aria-hidden="true" />
                  Choose a file
                  <input type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={(e) => void readFile(e)} />
                </label>
                {fileName ? <span className="truncate text-xs text-muted-foreground">{fileName}</span> : null}
                <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => setCsv(SAMPLE)}>
                  Use the sample
                </button>
              </div>
            </>
          ) : (
            <PreviewTable preview={preview} timezone={timezone} />
          )}
        </div>
        <DialogFooter className="flex-wrap">
          {preview ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>
              Back
            </Button>
          ) : (
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
          )}
          {preview ? (
            <Button type="button" disabled={busy || !ready.length} onClick={() => void confirm()}>
              {busy ? "Importing…" : `Import ${ready.length} ${ready.length === 1 ? "payment" : "payments"}`}
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={() => void runPreview()}>
              {busy ? "Reading…" : "Preview"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewTable({ preview, timezone }: { preview: ImportPreview; timezone: string }) {
  const { summary } = preview;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="success">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          {summary.ready} ready · {formatNumber(summary.amount)} EGP
        </Badge>
        {summary.unmatched ? <Badge tone="warning">{summary.unmatched} no matching patient</Badge> : null}
        {summary.invalid ? <Badge tone="danger">{summary.invalid} with problems</Badge> : null}
        <Badge>{summary.total} rows</Badge>
      </div>
      {preview.error ? <Alert tone="info">{preview.error}</Alert> : null}
      <div className="max-h-[50vh] overflow-auto rounded-lg border border-border">
        <Table className="relative">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Line</TH>
              <TH>Patient</TH>
              <TH>Amount</TH>
              <TH className="hidden md:table-cell">Date</TH>
              <TH className="hidden md:table-cell">Kind · method</TH>
            </TR>
          </THead>
          <TBody>
            {preview.rows.map((row) => (
              <PreviewRow key={row.line} row={row} timezone={timezone} />
            ))}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

function PreviewRow({ row, timezone }: { row: ImportPreviewRow; timezone: string }) {
  return (
    <TR className={row.ok ? undefined : "bg-danger/5"}>
      <TD className="font-mono text-xs text-muted-foreground">{row.line}</TD>
      <TD>
        {row.patient ? <div className="font-medium">{row.patient.fullName}</div> : <div className="text-muted-foreground">{row.name || "—"}</div>}
        <div className="font-mono text-xs text-muted-foreground">{row.phone ?? row.phoneText}</div>
        {row.problems.length ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {row.problems.map((p) => (
              <li key={p}>
                <Badge tone={p.startsWith("No patient") ? "warning" : "danger"} className="normal-case tracking-normal">
                  {p}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </TD>
      <TD className="whitespace-nowrap font-mono tabular-nums">{row.amount !== null ? `${formatNumber(row.amount)} EGP` : "—"}</TD>
      <TD className="hidden whitespace-nowrap font-mono text-xs md:table-cell">{row.paidAt ? formatDateTimeInTz(new Date(row.paidAt), timezone) : row.dateText}</TD>
      <TD className="hidden text-xs md:table-cell">
        {row.kindLabel} · {row.methodLabel}
        {row.reference ? <div className="font-mono text-muted-foreground">{row.reference}</div> : null}
      </TD>
    </TR>
  );
}
