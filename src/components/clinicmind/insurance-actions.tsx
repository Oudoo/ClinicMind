"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban, CalendarX2, CheckCheck, FilePlus2, HandCoins, Pencil, Plus, Send, ShieldPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { cn, formatNumber } from "@/lib/utils";
import { CATEGORY_LABELS, METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "@/modules/finance/constants";
import {
  COVER_CATEGORIES,
  COVER_RELATION_LABELS,
  COVER_RELATIONS,
  PAYER_KIND_LABELS,
  PAYER_KINDS,
  REFUSAL_REASON_LABELS,
  REFUSAL_REASONS,
  type CoverRelationValue,
  type PayerKindValue,
  type RefusalReasonValue,
} from "@/modules/insurance/constants";
import type { ContractDTO, PayerDetail } from "@/modules/insurance/payers";
import type { ApprovalDTO, CoverDTO } from "@/modules/insurance/covers";
import { financeErrorMessage } from "./finance-shared";

/**
 * The insurance dialogs: payers and their contracts (the owner), a patient's
 * cover and approvals (the desk), sending claims in a batch, and recording or
 * voiding a payer's answer (the owner).
 */

const issueText = (issues: Record<string, string>, key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);
const wholeOrNull = (v: string) => (v.trim() === "" ? null : Math.round(Number(v)));

function useSubmit() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  async function run(action: () => Promise<unknown>, done: string, close: () => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      toast({ tone: "success", title: done });
      close();
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, issues, setIssues, setError, run };
}

// ── Payers ───────────────────────────────────────────────────────────────────

type PayerFields = Pick<PayerDetail, "id" | "name" | "kind" | "contactName" | "phone" | "email" | "address" | "paymentDays" | "notes" | "archived">;

export function PayerButton({ payer }: { payer?: PayerFields }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={payer ? "outline" : "primary"} onClick={() => setOpen(true)}>
        {payer ? <Pencil className="h-4 w-4" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
        {payer ? "Edit" : "New payer"}
      </Button>
      {open ? <PayerDialog payer={payer} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PayerDialog({ payer, onClose }: { payer?: PayerFields; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState(payer?.name ?? "");
  const [kind, setKind] = useState<PayerKindValue>(payer?.kind ?? "INSURER");
  const [contactName, setContactName] = useState(payer?.contactName ?? "");
  const [phone, setPhone] = useState(payer?.phone ?? "");
  const [email, setEmail] = useState(payer?.email ?? "");
  const [address, setAddress] = useState(payer?.address ?? "");
  const [paymentDays, setPaymentDays] = useState(String(payer?.paymentDays ?? 60));
  const [notes, setNotes] = useState(payer?.notes ?? "");
  const [archived, setArchived] = useState(payer?.archived ?? false);
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: name.trim(),
      kind,
      contactName: contactName.trim() || undefined,
      phone: phone.trim() || undefined,
      email: email.trim() || undefined,
      address: address.trim() || undefined,
      paymentDays: Number(paymentDays) || 0,
      notes: notes.trim() || undefined,
      ...(payer ? { archived } : {}),
    };
    void s.run(
      async () => {
        const res = await apiFetch<{ payer: { id: string } }>(payer ? `/api/payers/${payer.id}` : "/api/payers", { method: payer ? "PATCH" : "POST", body });
        if (!payer) router.push(`/dashboard/finance/insurance/payers/${res.payer.id}`);
      },
      payer ? "Payer saved" : "Payer added",
      onClose,
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={payer ? "Edit the payer" : "New payer"} description="An insurance company (or the network that runs its cover), or a company paying for its staff.">
        <form onSubmit={submit} className="space-y-3" noValidate>
          {s.error ? <Alert>{s.error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`} hint={issueText(s.issues, "name")}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind" htmlFor={`${id}-kind`}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as PayerKindValue)}>
                {PAYER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {PAYER_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Days to pay a batch" htmlFor={`${id}-days`} hint={issueText(s.issues, "paymentDays") ?? "From the day it is sent"}>
              <Input id={`${id}-days`} type="number" inputMode="numeric" min={0} max={365} value={paymentDays} onChange={(e) => setPaymentDays(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact (optional)" htmlFor={`${id}-contact`}>
              <Input id={`${id}-contact`} value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Phone (optional)" htmlFor={`${id}-phone`}>
              <Input id={`${id}-phone`} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} inputMode="tel" />
            </Field>
          </div>
          <Field label="E-mail for claims (optional)" htmlFor={`${id}-email`} hint={issueText(s.issues, "email")}>
            <Input id={`${id}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Address (optional)" htmlFor={`${id}-address`}>
            <Input id={`${id}-address`} value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
          </Field>
          <Field label="Notes (optional)" htmlFor={`${id}-notes`}>
            <Textarea id={`${id}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="min-h-[3.5rem]" />
          </Field>
          {payer ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              No longer works with the clinic (kept with its claims)
            </label>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={s.busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={s.busy}>
              {s.busy ? "Saving…" : payer ? "Save" : "Add the payer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Contracts ────────────────────────────────────────────────────────────────

export interface PriceItemOption {
  id: string;
  name: string;
  category: string;
}

type CategoryChoice = "default" | "covered" | "approval" | "not";

export function ContractButton({ payerId, contract, priceItems, today, label }: { payerId: string; contract?: ContractDTO; priceItems: PriceItemOption[]; today: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={contract ? "outline" : "primary"} onClick={() => setOpen(true)}>
        {contract ? <Pencil className="h-4 w-4" aria-hidden="true" /> : <FilePlus2 className="h-4 w-4" aria-hidden="true" />}
        {label ?? (contract ? "Edit the contract" : "New contract")}
      </Button>
      {open ? <ContractDialog payerId={payerId} contract={contract} priceItems={priceItems} today={today} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ContractDialog({ payerId, contract, priceItems, today, onClose }: { payerId: string; contract?: ContractDTO; priceItems: PriceItemOption[]; today: string; onClose: () => void }) {
  const id = useId();
  const [reference, setReference] = useState(contract?.reference ?? "");
  const [validFrom, setValidFrom] = useState(contract?.validFrom ?? today);
  const [validTo, setValidTo] = useState(contract?.validTo ?? "");
  const [discountPct, setDiscountPct] = useState(String(contract?.discountPct ?? 0));
  const [copayPct, setCopayPct] = useState(String(contract?.copayPct ?? 20));
  const [annualLimit, setAnnualLimit] = useState(contract?.annualLimit ? String(contract.annualLimit) : "");
  const [approvalAbove, setApprovalAbove] = useState(contract?.approvalAbove !== null && contract?.approvalAbove !== undefined ? String(contract.approvalAbove) : "");
  const [coveredByDefault, setCoveredByDefault] = useState(contract?.coveredByDefault ?? true);
  const [note, setNote] = useState(contract?.note ?? "");
  const ruleOf = (category: string) => contract?.rules.find((r) => r.category === category);
  const [categories, setCategories] = useState<Record<string, { choice: CategoryChoice; copay: string }>>(() =>
    Object.fromEntries(
      COVER_CATEGORIES.map((c) => {
        const r = ruleOf(c);
        return [c, { choice: !r ? "default" : !r.covered ? "not" : r.needsApproval ? "approval" : "covered", copay: r?.copayPct !== null && r?.copayPct !== undefined ? String(r.copayPct) : "" }];
      }),
    ),
  );
  const [items, setItems] = useState<{ priceItemId: string; covered: boolean; copay: string }[]>(
    () => contract?.rules.filter((r) => r.priceItemId).map((r) => ({ priceItemId: r.priceItemId!, covered: r.covered, copay: r.copayPct !== null ? String(r.copayPct) : "" })) ?? [],
  );
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    const rules = [
      ...COVER_CATEGORIES.flatMap((c) => {
        const r = categories[c]!;
        if (r.choice === "default") return [];
        return [{ category: c, covered: r.choice !== "not", needsApproval: r.choice === "approval", ...(r.copay.trim() !== "" && r.choice !== "not" ? { copayPct: Math.round(Number(r.copay)) } : {}) }];
      }),
      ...items.filter((i) => i.priceItemId).map((i) => ({ priceItemId: i.priceItemId, covered: i.covered, needsApproval: false, ...(i.copay.trim() !== "" && i.covered ? { copayPct: Math.round(Number(i.copay)) } : {}) })),
    ];
    const body = {
      reference: reference.trim() || undefined,
      validFrom,
      validTo: validTo || undefined,
      discountPct: Math.round(Number(discountPct) || 0),
      copayPct: Math.round(Number(copayPct) || 0),
      annualLimit: wholeOrNull(annualLimit) ?? undefined,
      approvalAbove: wholeOrNull(approvalAbove) ?? undefined,
      coveredByDefault,
      note: note.trim() || undefined,
      rules,
    };
    void s.run(
      () => apiFetch(contract ? `/api/payer-contracts/${contract.id}` : `/api/payers/${payerId}/contracts`, { method: contract ? "PATCH" : "POST", body }),
      contract ? "Contract saved" : "Contract added",
      onClose,
    );
  }
  const setCategory = (c: string, patch: Partial<{ choice: CategoryChoice; copay: string }>) => setCategories((all) => ({ ...all, [c]: { ...all[c]!, ...patch } }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={contract ? "Edit the contract" : "New contract"}
        description={contract ? "Its terms apply to the claims to come; claims made keep their amounts." : "From its first day; an open contract before it ends the day before."}
        className="sm:max-w-2xl"
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          {s.error ? <Alert>{s.error}</Alert> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="From" htmlFor={`${id}-from`} hint={issueText(s.issues, "validFrom")}>
              <Input id={`${id}-from`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </Field>
            <Field label="To (optional)" htmlFor={`${id}-to`} hint={issueText(s.issues, "validTo")}>
              <Input id={`${id}-to`} type="date" min={validFrom} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </Field>
            <Field label="Its no. (optional)" htmlFor={`${id}-ref`}>
              <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Off our prices (%)" htmlFor={`${id}-discount`} hint={issueText(s.issues, "discountPct") ?? "The contract's price"}>
              <Input id={`${id}-discount`} type="number" inputMode="numeric" min={0} max={90} value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            </Field>
            <Field label="Patient pays (%)" htmlFor={`${id}-copay`} hint={issueText(s.issues, "copayPct") ?? "The co-pay"}>
              <Input id={`${id}-copay`} type="number" inputMode="numeric" min={0} max={100} value={copayPct} onChange={(e) => setCopayPct(e.target.value)} />
            </Field>
            <Field label="Yearly limit (EGP)" htmlFor={`${id}-limit`} hint={issueText(s.issues, "annualLimit") ?? "Per member; empty: none"}>
              <Input id={`${id}-limit`} type="number" inputMode="numeric" min={1} value={annualLimit} onChange={(e) => setAnnualLimit(e.target.value)} />
            </Field>
            <Field label="Approval above (EGP)" htmlFor={`${id}-approval`} hint={issueText(s.issues, "approvalAbove") ?? "One piece of work"}>
              <Input id={`${id}-approval`} type="number" inputMode="numeric" min={0} value={approvalAbove} onChange={(e) => setApprovalAbove(e.target.value)} />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What it covers</legend>
            <div className="divide-y divide-border rounded-lg border border-border">
              {COVER_CATEGORIES.map((c) => {
                const r = categories[c]!;
                return (
                  <div key={c} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="min-w-[7rem] flex-1 text-sm">{CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c}</span>
                    <Select aria-label={`${CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c}: covered?`} value={r.choice} onChange={(e) => setCategory(c, { choice: e.target.value as CategoryChoice })} className="h-9 w-auto min-w-[12rem]">
                      <option value="default">As the contract says</option>
                      <option value="covered">Covered</option>
                      <option value="approval">Covered, approval first</option>
                      <option value="not">Not covered</option>
                    </Select>
                    {r.choice === "covered" || r.choice === "approval" ? (
                      <Input aria-label={`${CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c}: the patient pays (%)`} placeholder="Co-pay %" type="number" min={0} max={100} value={r.copay} onChange={(e) => setCategory(c, { copay: e.target.value })} className="h-9 w-24" />
                    ) : null}
                  </div>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={coveredByDefault} onChange={(e) => setCoveredByDefault(e.target.checked)} />
              Work no rule names is covered
            </label>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Items that differ from their category</legend>
            {items.map((item, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Select aria-label="Price-list item" value={item.priceItemId} onChange={(e) => setItems((all) => all.map((x, j) => (j === i ? { ...x, priceItemId: e.target.value } : x)))} className="h-9 min-w-[12rem] flex-1">
                  <option value="">Choose an item</option>
                  {priceItems.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Covered?" value={item.covered ? "yes" : "no"} onChange={(e) => setItems((all) => all.map((x, j) => (j === i ? { ...x, covered: e.target.value === "yes" } : x)))} className="h-9 w-auto">
                  <option value="yes">Covered</option>
                  <option value="no">Not covered</option>
                </Select>
                {item.covered ? <Input aria-label="The patient pays (%)" placeholder="Co-pay %" type="number" min={0} max={100} value={item.copay} onChange={(e) => setItems((all) => all.map((x, j) => (j === i ? { ...x, copay: e.target.value } : x)))} className="h-9 w-24" /> : null}
                <Button type="button" size="icon" variant="ghost" aria-label="Take the item off" onClick={() => setItems((all) => all.filter((_, j) => j !== i))}>
                  <X className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => setItems((all) => [...all, { priceItemId: "", covered: true, copay: "" }])}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add an item
            </Button>
          </fieldset>
          <Field label="Note (optional)" htmlFor={`${id}-note`}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-[3rem]" />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={s.busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={s.busy}>
              {s.busy ? "Saving…" : contract ? "Save the contract" : "Add the contract"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── A patient's cover ────────────────────────────────────────────────────────

export interface PayerOption {
  id: string;
  name: string;
  kindLabel: string;
}

export function AddCoverButton({ patientId, payers, today }: { patientId: string; payers: PayerOption[]; today: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [payerId, setPayerId] = useState(payers[0]?.id ?? "");
  const [memberNumber, setMemberNumber] = useState("");
  const [plan, setPlan] = useState("");
  const [employer, setEmployer] = useState("");
  const [relation, setRelation] = useState<CoverRelationValue>("SELF");
  const [validFrom, setValidFrom] = useState(today);
  const [validTo, setValidTo] = useState("");
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(
      () =>
        apiFetch(`/api/patients/${patientId}/insurance`, {
          method: "POST",
          body: { payerId, memberNumber: memberNumber.trim(), plan: plan.trim() || undefined, employer: employer.trim() || undefined, relation, validFrom, validTo: validTo || undefined },
        }),
      "Cover added",
      () => setOpen(false),
    );
  }
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!payers.length} title={payers.length ? undefined : "Add the insurer or the company first"}>
        <ShieldPlus className="h-4 w-4" aria-hidden="true" />
        Add a cover
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Add a cover" description="The patient's card with an insurer or a company: work done while it is valid is claimed from it.">
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <Field label="Insurer or company" htmlFor={`${id}-payer`} hint={issueText(s.issues, "payerId")}>
              <Select id={`${id}-payer`} value={payerId} onChange={(e) => setPayerId(e.target.value)}>
                {payers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Card no." htmlFor={`${id}-member`} hint={issueText(s.issues, "memberNumber")}>
                <Input id={`${id}-member`} value={memberNumber} onChange={(e) => setMemberNumber(e.target.value)} maxLength={60} />
              </Field>
              <Field label="Plan (optional)" htmlFor={`${id}-plan`}>
                <Input id={`${id}-plan`} value={plan} onChange={(e) => setPlan(e.target.value)} maxLength={80} placeholder="e.g. Gold" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Whose card" htmlFor={`${id}-relation`}>
                <Select id={`${id}-relation`} value={relation} onChange={(e) => setRelation(e.target.value as CoverRelationValue)}>
                  {COVER_RELATIONS.map((r) => (
                    <option key={r} value={r}>
                      {COVER_RELATION_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Employer (optional)" htmlFor={`${id}-employer`}>
                <Input id={`${id}-employer`} value={employer} onChange={(e) => setEmployer(e.target.value)} maxLength={120} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Valid from" htmlFor={`${id}-from`} hint={issueText(s.issues, "validFrom")}>
                <Input id={`${id}-from`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
              </Field>
              <Field label="Until (optional)" htmlFor={`${id}-to`} hint={issueText(s.issues, "validTo")}>
                <Input id={`${id}-to`} type="date" min={validFrom} value={validTo} onChange={(e) => setValidTo(e.target.value)} />
              </Field>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={s.busy || !payerId}>
                {s.busy ? "Adding…" : "Add the cover"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function EndCoverButton({ cover, today }: { cover: CoverDTO; today: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [endOn, setEndOn] = useState(today < cover.validFrom ? cover.validFrom : today);
  const [reason, setReason] = useState("");
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      s.setIssues({ reason: "Say why the cover ends." });
      return;
    }
    void s.run(() => apiFetch(`/api/covers/${cover.id}/end`, { method: "POST", body: { endOn, reason: reason.trim() } }), "Cover ended", () => setOpen(false));
  }
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <CalendarX2 className="h-4 w-4" aria-hidden="true" />
        End the cover
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="End the cover" description={`${cover.payerName}, card ${cover.memberNumber}. Work after its last day is the patient's to pay.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <Field label="Its last day" htmlFor={`${id}-end`} hint={issueText(s.issues, "endOn")}>
              <Input id={`${id}-end`} type="date" min={cover.validFrom} max={cover.validTo ?? undefined} value={endOn} onChange={(e) => setEndOn(e.target.value)} />
            </Field>
            <Field label="Why" htmlFor={`${id}-reason`} hint={issueText(s.issues, "reason")}>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[3.5rem]" placeholder="e.g. Left the company" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={s.busy}>
                {s.busy ? "Ending…" : "End the cover"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────

export function RequestApprovalButton({ patientId, cover, today }: { patientId: string; cover: CoverDTO; today: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [procedures, setProcedures] = useState<{ id: string; label: string; amount: number; status: string }[] | null>(null);
  const [procedureId, setProcedureId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [requestedOn, setRequestedOn] = useState(today);
  const [note, setNote] = useState("");
  const s = useSubmit();
  useEffect(() => {
    if (!open || procedures) return;
    let live = true;
    apiFetch<{ procedures: { id: string; label: string; amount: number; status: string }[] }>(`/api/patients/${patientId}/approvals`)
      .then((r) => live && setProcedures(r.procedures))
      .catch(() => live && setProcedures([]));
    return () => {
      live = false;
    };
  }, [open, procedures, patientId]);
  function choose(pid: string) {
    setProcedureId(pid);
    const p = procedures?.find((x) => x.id === pid);
    if (p) {
      if (!description.trim()) setDescription(p.label);
      if (!amount.trim()) setAmount(String(p.amount));
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(
      () =>
        apiFetch(`/api/patients/${patientId}/approvals`, {
          method: "POST",
          body: { coverageId: cover.id, procedureId: procedureId || undefined, description: description.trim(), amount: Math.round(Number(amount) || 0), requestedOn, note: note.trim() || undefined },
        }),
      "Approval asked for",
      () => setOpen(false),
    );
  }
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Send className="h-4 w-4" aria-hidden="true" />
        Ask for an approval
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Ask for an approval" description={`Of ${cover.payerName}, card ${cover.memberNumber}. Record its answer when it comes.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <Field label="For the work (optional)" htmlFor={`${id}-procedure`}>
              <Select id={`${id}-procedure`} value={procedureId} onChange={(e) => choose(e.target.value)} disabled={!procedures}>
                <option value="">{procedures ? "No work in particular" : "Loading…"}</option>
                {(procedures ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                    {p.status === "PLANNED" ? " (planned)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="What it is for" htmlFor={`${id}-what`} hint={issueText(s.issues, "description")}>
              <Input id={`${id}-what`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={issueText(s.issues, "amount")}>
                <Input id={`${id}-amount`} type="number" inputMode="numeric" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Asked on" htmlFor={`${id}-on`} hint={issueText(s.issues, "requestedOn")}>
                <Input id={`${id}-on`} type="date" max={today} value={requestedOn} onChange={(e) => setRequestedOn(e.target.value)} />
              </Field>
            </div>
            <Field label="Note (optional)" htmlFor={`${id}-note`}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[3rem]" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={s.busy}>
                {s.busy ? "Saving…" : "Ask for it"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AnswerApprovalButton({ approval, today }: { approval: ApprovalDTO; today: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"APPROVED" | "REFUSED">("APPROVED");
  const [approvalNumber, setApprovalNumber] = useState("");
  const [approvedAmount, setApprovedAmount] = useState(String(approval.amount));
  const [validUntil, setValidUntil] = useState("");
  const [reason, setReason] = useState("");
  const [answeredOn, setAnsweredOn] = useState(today);
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    const body =
      status === "APPROVED"
        ? { status, approvalNumber: approvalNumber.trim(), approvedAmount: Math.round(Number(approvedAmount) || 0), validUntil: validUntil || undefined, answeredOn }
        : { status, reason: reason.trim(), answeredOn };
    void s.run(() => apiFetch(`/api/approvals/${approval.id}/answer`, { method: "POST", body }), status === "APPROVED" ? "Approval recorded" : "Refusal recorded", () => setOpen(false));
  }
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`Record the answer to ${approval.description}`}>
        <CheckCheck className="h-4 w-4" aria-hidden="true" />
        The answer
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="The payer's answer" description={`${approval.payerName}: ${approval.description}, ${formatNumber(approval.amount)} EGP asked.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <div role="radiogroup" aria-label="The answer" className="flex gap-4 text-sm">
              {(["APPROVED", "REFUSED"] as const).map((v) => (
                <label key={v} className="flex items-center gap-2">
                  <input type="radio" name={`${id}-status`} checked={status === v} onChange={() => setStatus(v)} />
                  {v === "APPROVED" ? "Approved" : "Refused"}
                </label>
              ))}
            </div>
            {status === "APPROVED" ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Its approval no." htmlFor={`${id}-number`} hint={issueText(s.issues, "approvalNumber")}>
                    <Input id={`${id}-number`} value={approvalNumber} onChange={(e) => setApprovalNumber(e.target.value)} maxLength={60} />
                  </Field>
                  <Field label="Amount approved (EGP)" htmlFor={`${id}-amount`} hint={issueText(s.issues, "approvedAmount")}>
                    <Input id={`${id}-amount`} type="number" inputMode="numeric" min={1} value={approvedAmount} onChange={(e) => setApprovedAmount(e.target.value)} />
                  </Field>
                </div>
                <Field label="Valid until (optional)" htmlFor={`${id}-until`} hint={issueText(s.issues, "validUntil")}>
                  <Input id={`${id}-until`} type="date" min={answeredOn} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
                </Field>
              </>
            ) : (
              <Field label="Why it refused" htmlFor={`${id}-reason`} hint={issueText(s.issues, "reason")}>
                <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[3.5rem]" />
              </Field>
            )}
            <Field label="Answered on" htmlFor={`${id}-on`} hint={issueText(s.issues, "answeredOn")}>
              <Input id={`${id}-on`} type="date" max={today} value={answeredOn} onChange={(e) => setAnsweredOn(e.target.value)} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={s.busy}>
                {s.busy ? "Saving…" : "Record the answer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CancelApprovalButton({ approval }: { approval: ApprovalDTO }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      s.setIssues({ reason: "Say why, in a few words." });
      return;
    }
    void s.run(() => apiFetch(`/api/approvals/${approval.id}/cancel`, { method: "POST", body: { reason: reason.trim() } }), "Approval cancelled", () => setOpen(false));
  }
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setOpen(true)} aria-label={`Cancel the approval for ${approval.description}`}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        Cancel
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Cancel this approval?" description={`${approval.description}. It stays on record, cancelled.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <Field label="Why" htmlFor={`${id}-reason`} hint={issueText(s.issues, "reason")}>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[3.5rem]" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={s.busy}>
                {s.busy ? "Cancelling…" : "Cancel the approval"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Claims to the payer and its answer ───────────────────────────────────────

export function SendClaimsButton({ payerId, payerName, claims, amount, today }: { payerId: string; payerName: string; claims: number; amount: number; today: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [sentOn, setSentOn] = useState(today);
  const [reference, setReference] = useState("");
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    void s.run(() => apiFetch("/api/claim-batches", { method: "POST", body: { payerId, sentOn, reference: reference.trim() || undefined } }), `Claims sent to ${payerName}`, () => setOpen(false));
  }
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} aria-label={`Send ${claims} claims to ${payerName}`}>
        <Send className="h-4 w-4" aria-hidden="true" />
        Send
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Send the claims to ${payerName}`} description={`${claims} claim${claims === 1 ? "" : "s"}, ${formatNumber(amount)} EGP, in one batch for each branch. A batch is fixed once sent.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sent on" htmlFor={`${id}-on`} hint={issueText(s.issues, "sentOn")}>
                <Input id={`${id}-on`} type="date" max={today} value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
              </Field>
              <Field label="Their reference (optional)" htmlFor={`${id}-ref`}>
                <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              </Field>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={s.busy}>
                {s.busy ? "Sending…" : "Send them"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface AnswerLineOption {
  id: string;
  claimNumber: string;
  batchNumber: string | null;
  patientName: string;
  memberNumber: string;
  description: string;
  owed: number;
}

interface AnswerRow {
  paid: string;
  refused: string;
  reason: RefusalReasonValue | "";
  writeOff: boolean;
}

export function RecordAnswerButton({ payerId, payerName, batchId, today, label = "Record the payer's answer" }: { payerId: string; payerName: string; batchId?: string; today: string; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<AnswerLineOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, AnswerRow>>({});
  const [paidOn, setPaidOn] = useState(today);
  const [method, setMethod] = useState<PaymentMethodValue>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const s = useSubmit();
  useEffect(() => {
    if (!open) return;
    let live = true;
    apiFetch<{ lines: AnswerLineOption[] }>(`/api/payer-payments?${new URLSearchParams({ payerId, ...(batchId ? { batchId } : {}) }).toString()}`)
      .then((r) => {
        if (!live) return;
        setLines(r.lines);
        setRows(Object.fromEntries(r.lines.map((l) => [l.id, { paid: String(l.owed), refused: "", reason: "", writeOff: false }])));
      })
      .catch((err: unknown) => live && setLoadError(financeErrorMessage(err)));
    return () => {
      live = false;
    };
  }, [open, payerId, batchId]);
  const setRow = (lineId: string, patch: Partial<AnswerRow>) => setRows((all) => ({ ...all, [lineId]: { ...all[lineId]!, ...patch } }));
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  const totals = (lines ?? []).reduce((t, l) => ({ paid: t.paid + num(rows[l.id]?.paid ?? ""), refused: t.refused + num(rows[l.id]?.refused ?? "") }), { paid: 0, refused: 0 });
  function submit(e: FormEvent) {
    e.preventDefault();
    const answered = (lines ?? [])
      .map((l) => ({ l, r: rows[l.id]! }))
      .filter(({ r }) => num(r.paid) + num(r.refused) > 0)
      .map(({ l, r }) => ({ claimLineId: l.id, paid: num(r.paid), refused: num(r.refused), ...(num(r.refused) > 0 ? { reason: r.reason || undefined, writeOff: r.writeOff } : {}) }));
    if (!answered.length) {
      s.setError("Enter what the payer paid or refused on at least one line.");
      return;
    }
    const missingReason = answered.find((a) => a.refused > 0 && !a.reason);
    if (missingReason) {
      s.setError("Say why the payer refused each line it refused.");
      return;
    }
    void s.run(
      () => apiFetch("/api/payer-payments", { method: "POST", body: { payerId, batchId, paidOn, method, reference: reference.trim() || undefined, lines: answered } }),
      `${payerName}'s answer recorded`,
      () => setOpen(false),
    );
  }
  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setLines(null);
          setLoadError(null);
          setOpen(true);
        }}
      >
        <HandCoins className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`${payerName}'s answer`} description="What it paid and what it refused, line by line, as its remittance says. What it refuses the patient owes again, unless you write it off." className="sm:max-w-3xl">
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error || loadError ? <Alert>{s.error ?? loadError}</Alert> : null}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Paid on" htmlFor={`${id}-on`} hint={issueText(s.issues, "paidOn")}>
                <Input id={`${id}-on`} type="date" max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
              </Field>
              <Field label="How" htmlFor={`${id}-method`}>
                <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                  {PAYMENT_METHODS.filter((m) => m === "BANK_TRANSFER" || m === "CHEQUE" || m === "INSTAPAY" || m === "OTHER").map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Its reference (optional)" htmlFor={`${id}-ref`}>
                <Input id={`${id}-ref`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              </Field>
            </div>
            {!lines ? (
              <p className="text-sm text-muted-foreground">{loadError ? "The claims could not be loaded." : "Loading the claims…"}</p>
            ) : !lines.length ? (
              <p className="text-sm text-muted-foreground">Nothing is owed on these claims.</p>
            ) : (
              <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1" data-testid="answer-lines">
                {lines.map((l) => {
                  const r = rows[l.id]!;
                  return (
                    <div key={l.id} className="rounded-lg border border-border p-2.5 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="font-medium">
                          {l.patientName} <span className="font-mono text-xs text-muted-foreground">{l.claimNumber}</span>
                        </span>
                        <span className="font-mono text-xs tabular-nums">owed {formatNumber(l.owed)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{l.description}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input aria-label={`Paid on ${l.claimNumber}: ${l.description}`} type="number" inputMode="numeric" min={0} max={l.owed} value={r.paid} onChange={(e) => setRow(l.id, { paid: e.target.value })} className="h-9 w-28" />
                        <Input aria-label={`Refused on ${l.claimNumber}: ${l.description}`} placeholder="Refused" type="number" inputMode="numeric" min={0} max={l.owed} value={r.refused} onChange={(e) => setRow(l.id, { refused: e.target.value })} className="h-9 w-28" />
                        {num(r.refused) > 0 ? (
                          <>
                            <Select aria-label={`Why refused on ${l.claimNumber}`} value={r.reason} onChange={(e) => setRow(l.id, { reason: e.target.value as RefusalReasonValue })} className={cn("h-9 w-auto", !r.reason && "border-danger")}>
                              <option value="">Why refused…</option>
                              {REFUSAL_REASONS.map((reason) => (
                                <option key={reason} value={reason}>
                                  {REFUSAL_REASON_LABELS[reason]}
                                </option>
                              ))}
                            </Select>
                            <label className="flex items-center gap-1.5 text-xs">
                              <Checkbox checked={r.writeOff} onChange={(e) => setRow(l.id, { writeOff: e.target.checked })} />
                              Write it off
                            </label>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-sm">
              Paid <span className="font-mono tabular-nums">{formatNumber(totals.paid)}</span> EGP · refused <span className="font-mono tabular-nums">{formatNumber(totals.refused)}</span> EGP
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={s.busy || !lines?.length}>
                {s.busy ? "Recording…" : "Record the answer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function VoidPayerPaymentButton({ paymentId, label }: { paymentId: string; label: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const s = useSubmit();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      s.setIssues({ reason: "Say why, in a few words." });
      return;
    }
    void s.run(() => apiFetch(`/api/payer-payments/${paymentId}/void`, { method: "POST", body: { reason: reason.trim() } }), "Answer voided", () => setOpen(false));
  }
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setOpen(true)} aria-label={`Void ${label}`}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        Void
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Void this answer?" description={`${label}. Its lines are owed by the payer again, and what it wrote off goes back.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {s.error ? <Alert>{s.error}</Alert> : null}
            <Field label="Why" htmlFor={`${id}-reason`} hint={issueText(s.issues, "reason")}>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[3.5rem]" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={s.busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={s.busy}>
                {s.busy ? "Voiding…" : "Void the answer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
