"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { financeErrorMessage, type ProcedureCostItem } from "./finance-shared";

const KIND_LABELS = { LAB: "Lab", MATERIAL: "Materials" } as const;

/**
 * What a procedure cost the clinic, which comes off the work before the
 * doctor's share: the price list's materials for it, and the lab's bills and
 * other materials entered on it. The desk adds a cost; the owner voids one
 * entered by mistake, with the reason.
 */
export function ProcedureCosts({
  procedureId,
  label,
  materials,
  costs,
  timezone,
  canAdd,
  canVoid,
}: {
  procedureId: string;
  label: string;
  materials: number;
  costs: ProcedureCostItem[];
  timezone: string;
  canAdd: boolean;
  canVoid: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<ProcedureCostItem | null>(null);
  const live = costs.filter((c) => !c.voidedAt);
  const total = materials + live.reduce((s, c) => s + c.amount, 0);
  if (!materials && !costs.length && !canAdd) return null;
  return (
    <div className="mt-2 space-y-1 border-t border-dashed border-border pt-2 text-xs" data-testid="procedure-costs" data-procedure={procedureId}>
      {materials || costs.length ? (
        <>
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="data-label">Costs</span>
            <span className="font-mono tabular-nums">{formatNumber(total)} EGP</span>
          </p>
          <ul className="space-y-0.5">
            {materials ? (
              <li className="flex justify-between gap-2 text-muted-foreground">
                <span>Materials, from the price list</span>
                <span className="font-mono tabular-nums">{formatNumber(materials)}</span>
              </li>
            ) : null}
            {costs.map((c) => (
              <li key={c.id} className={`flex items-center justify-between gap-2 ${c.voidedAt ? "text-muted-foreground line-through" : ""}`} title={c.voidReason ? `Voided: ${c.voidReason}` : undefined}>
                <span className="min-w-0 truncate">
                  {KIND_LABELS[c.kind]}: {c.description} · {formatDateInTz(new Date(c.incurredAt), timezone, { day: "numeric", month: "short" })}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="font-mono tabular-nums">{formatNumber(c.amount)}</span>
                  {canVoid && !c.voidedAt ? (
                    <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Void ${c.description}`} onClick={() => setVoiding(c)}>
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {canAdd ? (
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3" aria-hidden="true" />
          Add a cost
        </Button>
      ) : null}
      {adding ? <AddCostDialog procedureId={procedureId} label={label} timezone={timezone} onClose={() => setAdding(false)} /> : null}
      {voiding ? <VoidCostDialog cost={voiding} onClose={() => setVoiding(null)} /> : null}
    </div>
  );
}

function AddCostDialog({ procedureId, label, timezone, onClose }: { procedureId: string; label: string; timezone: string; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const [kind, setKind] = useState<"LAB" | "MATERIAL">("LAB");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState(today);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = Number(amount.replace(/[,\s]/g, ""));
    const next: Record<string, string> = {};
    if (description.trim().length < 2) next.description = "Say what it is.";
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/procedures/${procedureId}/costs`, { method: "POST", body: { kind, description: description.trim(), amount: value, incurredOn: day } });
      toast({ tone: "success", title: "Cost added", description: "It comes off the work before the doctor's share." });
      onClose();
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add a cost" description={`For ${label}. The lab's bill or materials used: it comes off the work before the doctor's share.`}>
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind" htmlFor={`${id}-kind`}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as "LAB" | "MATERIAL")}>
                <option value="LAB">Lab</option>
                <option value="MATERIAL">Materials</option>
              </Select>
            </Field>
            <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
              <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="What" htmlFor={`${id}-description`} hint={hint("description", kind === "LAB" ? "e.g. Histopathology, Nile Lab" : "e.g. Extra filler syringe")}>
            <Input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Day of the bill" htmlFor={`${id}-day`} hint={hint("incurredOn")}>
            <Input id={`${id}-day`} type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add the cost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VoidCostDialog({ cost, onClose }: { cost: ProcedureCostItem; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (reason.trim().length < 3) {
      setError("Say why, in a few words.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/procedure-costs/${cost.id}/void`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Cost voided" });
      onClose();
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Void ${cost.description}?`} description={`${formatNumber(cost.amount)} EGP no longer comes off the doctor's share. It stays on record, struck through.`}>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Why" htmlFor={`${id}-reason`}>
            <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[4rem]" />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Keep it
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? "Voiding…" : "Void the cost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
