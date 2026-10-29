"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Lock, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { financeErrorMessage } from "./finance-shared";

export interface ShiftMethodItem {
  method: string;
  label: string;
  expected: number;
}

const toInt = (s: string) => Number(s.replace(/[,\s]/g, ""));

/** Open the cashier's shift with the cash in the drawer. */
export function OpenShiftForm({ clinics }: { clinics: { id: string; name: string }[] }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [float, setFloat] = useState("");
  const [clinicId, setClinicId] = useState(clinics[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = toInt(float || "0");
    if (!Number.isInteger(value) || value < 0) {
      setError("The cash in the drawer: whole EGP, 0 or more.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/cash/shift", { method: "POST", body: { openingFloat: value, clinicId: clinicId || undefined } });
      toast({ tone: "success", title: "Your shift is open", description: `${formatNumber(value)} EGP in the drawer.` });
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3" noValidate>
      {error ? (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      ) : null}
      <div className="w-44">
        <Field label="Cash in the drawer (EGP)" htmlFor={`${id}-float`}>
          <Input id={`${id}-float`} inputMode="numeric" value={float} onChange={(e) => setFloat(e.target.value)} placeholder="e.g. 1000" />
        </Field>
      </div>
      {clinics.length > 1 ? (
        <div className="w-56">
          <Field label="Branch" htmlFor={`${id}-branch`}>
            <Select id={`${id}-branch`} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      <Button type="submit" disabled={busy} className="h-10">
        <LogIn className="h-4 w-4" aria-hidden="true" />
        {busy ? "Opening…" : "Open my shift"}
      </Button>
    </form>
  );
}

/**
 * Close a shift with what is in the drawer, method by method; a difference
 * from what is expected needs its reason. The cashier closes their own, the
 * owner anyone's.
 */
export function CloseShiftButton({ shiftId, cashier, methods, own }: { shiftId: string; cashier: string; methods: ShiftMethodItem[]; own: boolean }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const difference = (m: ShiftMethodItem) => {
    const raw = counted[m.method];
    if (raw === undefined || raw.trim() === "") return null;
    const n = toInt(raw);
    return Number.isInteger(n) ? n - m.expected : null;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    const counts: { method: string; counted: number; reason?: string }[] = [];
    for (const m of methods) {
      const n = toInt(counted[m.method] ?? "");
      if ((counted[m.method] ?? "").trim() === "" || !Number.isInteger(n) || n < 0) {
        next[m.method] = "Count it: whole EGP.";
        continue;
      }
      const diff = n - m.expected;
      if (diff !== 0 && !(reasons[m.method] ?? "").trim()) next[`${m.method}.reason`] = `Say why it is ${diff > 0 ? "over" : "short"}.`;
      counts.push({ method: m.method, counted: n, ...(diff !== 0 ? { reason: (reasons[m.method] ?? "").trim() } : {}) });
    }
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/cash/shifts/${shiftId}/close`, { method: "POST", body: { counts, note: note.trim() || undefined } });
      toast({ tone: "success", title: own ? "Your shift is closed" : `${cashier}'s shift is closed`, description: "Counted and on file for the day." });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setError(Object.keys(fields).length ? Object.values(fields).join(" ") : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant={own ? "primary" : "outline"} onClick={() => setOpen(true)}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        {own ? "Close my shift" : "Close this shift"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={own ? "Close your shift" : `Close ${cashier}'s shift`} description="Count what is in the drawer (and the card slips, transfers and the rest), method by method. Any difference needs its reason." className="max-w-lg">
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            {methods.map((m) => {
              const diff = difference(m);
              return (
                <div key={m.method} className="space-y-2 rounded-md border border-border p-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_9rem] sm:items-end">
                    <p className="text-sm">
                      <span className="font-medium">{m.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        Expected <span className="font-mono tabular-nums">{formatNumber(m.expected)}</span> EGP{m.method === "CASH" ? " (with the float)" : ""}
                      </span>
                    </p>
                    <Field label="Counted (EGP)" htmlFor={`${id}-${m.method}`} hint={issues[m.method] ? <span className="text-danger">{issues[m.method]}</span> : undefined}>
                      <Input
                        id={`${id}-${m.method}`}
                        inputMode="numeric"
                        value={counted[m.method] ?? ""}
                        onChange={(e) => setCounted((c) => ({ ...c, [m.method]: e.target.value }))}
                        aria-invalid={issues[m.method] ? true : undefined}
                      />
                    </Field>
                  </div>
                  {diff !== null && diff !== 0 ? (
                    <Field
                      label={`${diff > 0 ? "Over" : "Short"} by ${formatNumber(Math.abs(diff))} EGP: why?`}
                      htmlFor={`${id}-${m.method}-reason`}
                      hint={issues[`${m.method}.reason`] ? <span className="text-danger">{issues[`${m.method}.reason`]}</span> : undefined}
                    >
                      <Input id={`${id}-${m.method}-reason`} value={reasons[m.method] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [m.method]: e.target.value }))} maxLength={300} />
                    </Field>
                  ) : null}
                </div>
              );
            })}
            <Field label="Note" htmlFor={`${id}-note`} hint="Optional">
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Not yet
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Closing…" : "Close the shift"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The owner signs a branch's day off: every shift is closed; from then on the day is locked. */
export function SignOffDayButton({ date, dateLabel, clinicId }: { date: string; dateLabel: string; clinicId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-4 w-4" aria-hidden="true" />
        Sign off the day
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Sign off ${dateLabel}?`}
        description="The day's money is then locked: nothing more is recorded on it, and nothing on it is voided. This cannot be undone."
        confirmLabel={busy ? "Signing off…" : "Sign off the day"}
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await apiFetch("/api/cash/day", { method: "POST", body: { date, clinicId } });
            toast({ tone: "success", title: `${dateLabel} is signed off`, description: "Its money is locked." });
            setOpen(false);
            router.refresh();
          } catch (err) {
            toast({ tone: "danger", title: "The day is not signed off", description: financeErrorMessage(err) });
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}
