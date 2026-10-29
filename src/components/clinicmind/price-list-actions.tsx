"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatDateInTz, fromDateKey } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { CATEGORY_LABELS, PRICE_CATEGORIES, PRICE_UNITS, UNIT_LABELS, type PriceCategoryValue, type PriceUnitValue } from "@/modules/finance/constants";
import { financeErrorMessage } from "./finance-shared";

/** What the price-list dialogs choose from (serializable, from the page). */
export interface PriceFormOptions {
  treatments: { id: string; name: string; category: string | null }[];
  clinics: { id: string; name: string }[];
  /** Single items a course package can be made of. */
  sessionItems: { id: string; code: string; name: string }[];
  timezone: string;
}

interface ItemDetail {
  id: string;
  code: string;
  name: string;
  category: PriceCategoryValue;
  unit: PriceUnitValue;
  unitLabel: string | null;
  treatment: { id: string; name: string };
  sessions: number | null;
  sessionItem: { id: string; code: string; name: string } | null;
  active: boolean;
  materialCost: number;
  price: number | null;
  history: { id: string; clinicId: string | null; amount: number; effectiveFrom: string; createdBy: string | null; scheduled: boolean }[];
}

const toInt = (s: string) => Number(s.replace(/[,\s]/g, ""));

/** Name, category, unit, treatment and course fields, shared by the add and edit forms. */
function ItemFields({
  idPrefix,
  options,
  issues,
  value,
  onChange,
  selfId,
}: {
  idPrefix: string;
  options: PriceFormOptions;
  issues: Record<string, string>;
  value: { name: string; category: PriceCategoryValue; unit: PriceUnitValue; unitLabel: string; treatmentId: string; sessions: string; sessionItemId: string; materialCost: string };
  onChange: (patch: Partial<typeof value>) => void;
  selfId?: string;
}) {
  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Field label="Name" htmlFor={`${idPrefix}-name`} hint={hint("name", "As it reads on the invoice")}>
        <Input id={`${idPrefix}-name`} value={value.name} onChange={(e) => onChange({ name: e.target.value })} maxLength={120} />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Category" htmlFor={`${idPrefix}-category`} hint={hint("category")}>
          <Select id={`${idPrefix}-category`} value={value.category} onChange={(e) => onChange({ category: e.target.value as PriceCategoryValue })}>
            {PRICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Treatment" htmlFor={`${idPrefix}-treatment`} hint={hint("treatmentId", "Reports and aftercare group by it")}>
          <Select id={`${idPrefix}-treatment`} value={value.treatmentId} onChange={(e) => onChange({ treatmentId: e.target.value })}>
            {options.treatments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Charged" htmlFor={`${idPrefix}-unit`} hint={hint("unit")}>
          <Select id={`${idPrefix}-unit`} value={value.unit} onChange={(e) => onChange({ unit: e.target.value as PriceUnitValue })}>
            {PRICE_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_LABELS[u]}
              </option>
            ))}
          </Select>
        </Field>
        {value.unit === "UNIT" ? (
          <Field label="Unit name" htmlFor={`${idPrefix}-unit-label`} hint={hint("unitLabel", "e.g. graft, syringe")}>
            <Input id={`${idPrefix}-unit-label`} value={value.unitLabel} onChange={(e) => onChange({ unitLabel: e.target.value })} maxLength={30} />
          </Field>
        ) : null}
      </div>
      <Field label="Materials per unit (EGP)" htmlFor={`${idPrefix}-material`} hint={hint("materialCost", "What one unit uses (kit, syringe, consumables): taken off before a doctor's share")}>
        <Input id={`${idPrefix}-material`} inputMode="numeric" value={value.materialCost} onChange={(e) => onChange({ materialCost: e.target.value })} className="sm:w-40" />
      </Field>
      {value.unit === "PACKAGE" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7rem_1fr]">
          <Field label="Sessions" htmlFor={`${idPrefix}-sessions`} hint={hint("sessions")}>
            <Input id={`${idPrefix}-sessions`} inputMode="numeric" value={value.sessions} onChange={(e) => onChange({ sessions: e.target.value })} />
          </Field>
          <Field label="Each session is" htmlFor={`${idPrefix}-session-item`} hint={hint("sessionItemId")}>
            <Select id={`${idPrefix}-session-item`} value={value.sessionItemId} onChange={(e) => onChange({ sessionItemId: e.target.value })}>
              <option value="">Choose…</option>
              {options.sessionItems
                .filter((s) => s.id !== selfId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      ) : null}
    </>
  );
}

function blankItem(options: PriceFormOptions) {
  const t = options.treatments[0];
  const category = (PRICE_CATEGORIES as readonly string[]).includes(t?.category ?? "") ? (t!.category as PriceCategoryValue) : "general";
  return { name: "", category, unit: "SESSION" as PriceUnitValue, unitLabel: "", treatmentId: t?.id ?? "", sessions: "", sessionItemId: "", materialCost: "" };
}

/** "Add item": code, name, unit, treatment, the first price and the day it starts. */
export function NewPriceItemButton({ options }: { options: PriceFormOptions }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [fields, setFields] = useState(() => blankItem(options));
  const [price, setPrice] = useState("");
  const [from, setFrom] = useState(() => dateKeyInTz(new Date(), options.timezone));
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ item: { code: string; name: string } }>("/api/prices", {
        method: "POST",
        body: {
          code,
          ...fields,
          sessions: fields.unit === "PACKAGE" ? fields.sessions : undefined,
          sessionItemId: fields.unit === "PACKAGE" ? fields.sessionItemId : undefined,
          unitLabel: fields.unit === "UNIT" ? fields.unitLabel : undefined,
          materialCost: fields.materialCost.trim() ? toInt(fields.materialCost) : undefined,
          price: toInt(price),
          effectiveFrom: from,
        },
      });
      setOpen(false);
      setCode("");
      setFields(blankItem(options));
      setPrice("");
      setIssues({});
      toast({ tone: "success", title: `${res.item.code} added`, description: res.item.name });
      router.refresh();
    } catch (err) {
      const found = fieldErrors(err);
      setIssues(found);
      setError(Object.keys(found).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add item
      </Button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent title="Add to the price list" description="The code is printed on invoices and cannot change later." className="max-w-xl">
            <form onSubmit={submit} className="space-y-4" noValidate>
              {error ? <Alert>{error}</Alert> : null}
              <Field label="Code" htmlFor={`${id}-code`} hint={hint("code", "2–20 capitals, digits or dashes, e.g. LSR-FACE")}>
                <Input id={`${id}-code`} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} className="font-mono" />
              </Field>
              <ItemFields idPrefix={id} options={options} issues={issues} value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Price (EGP)" htmlFor={`${id}-price`} hint={hint("price", fields.unit === "PACKAGE" ? "For the whole course" : "Per unit charged")}>
                  <Input id={`${id}-price`} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
                </Field>
                <Field label="From" htmlFor={`${id}-from`} hint={hint("effectiveFrom", "Today or later")}>
                  <Input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline" disabled={busy}>
                    Close
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Add item"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** Edit an item, see its price history, schedule a new price or withdraw a scheduled one. */
export function EditPriceItemButton({ itemId, label, options }: { itemId: string; label: string; options: PriceFormOptions }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={label} title={label}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </Button>
      {open ? <EditPriceItemDialog itemId={itemId} options={options} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function EditPriceItemDialog({ itemId, options, onClose }: { itemId: string; options: PriceFormOptions; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [fields, setFields] = useState(() => blankItem(options));
  const [active, setActive] = useState(true);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(() => dateKeyInTz(new Date(), options.timezone));
  const [branch, setBranch] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function load(detail: ItemDetail) {
    setItem(detail);
    setFields({
      name: detail.name,
      category: detail.category,
      unit: detail.unit,
      unitLabel: detail.unitLabel ?? "",
      treatmentId: detail.treatment.id,
      sessions: detail.sessions ? String(detail.sessions) : "",
      sessionItemId: detail.sessionItem?.id ?? "",
      materialCost: detail.materialCost ? String(detail.materialCost) : "",
    });
    setActive(detail.active);
  }

  useEffect(() => {
    let live = true;
    apiFetch<{ item: ItemDetail }>(`/api/prices/${itemId}`)
      .then((res) => live && load(res.item))
      .catch((err) => live && setError(financeErrorMessage(err)));
    return () => {
      live = false;
    };
  }, [itemId]);

  async function run(action: () => Promise<{ item: ItemDetail }>, done: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      load(res.item);
      setIssues({});
      toast({ tone: "success", title: done, description: `${res.item.code} · ${res.item.name}` });
      router.refresh();
      return true;
    } catch (err) {
      const found = fieldErrors(err);
      setIssues(found);
      setError(Object.keys(found).length ? "Please check the highlighted fields." : financeErrorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void run(
      () =>
        apiFetch(`/api/prices/${itemId}`, {
          method: "PATCH",
          body: {
            ...fields,
            unitLabel: fields.unit === "UNIT" ? fields.unitLabel : "",
            sessions: fields.unit === "PACKAGE" ? fields.sessions : "",
            sessionItemId: fields.unit === "PACKAGE" ? fields.sessionItemId : "",
            materialCost: fields.materialCost.trim() ? toInt(fields.materialCost) : 0,
            active,
          },
        }),
      "Item saved",
    );
  }

  async function schedule(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () => apiFetch(`/api/prices/${itemId}/prices`, { method: "POST", body: { amount: toInt(amount), effectiveFrom: from, clinicId: branch || undefined } }),
      "Price set",
    );
    if (ok) setAmount("");
  }

  const branchName = (clinicId: string | null) => (clinicId ? (options.clinics.find((c) => c.id === clinicId)?.name ?? "Branch") : "Clinic-wide");
  const day = (key: string) => formatDateInTz(fromDateKey(key, options.timezone) ?? new Date(), options.timezone, { day: "numeric", month: "short", year: "numeric" });
  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={item ? `${item.code} · ${item.name}` : "Price-list item"} description="The code stays as it is; prices change from a day on." className="max-w-2xl">
        {error ? <Alert>{error}</Alert> : null}
        {item ? (
          <div className="space-y-6">
            <form onSubmit={save} className="space-y-4" noValidate aria-label="Item">
              <ItemFields idPrefix={id} options={options} issues={issues} value={fields} onChange={(patch) => setFields((f) => ({ ...f, ...patch }))} selfId={item.id} />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
                On the price list (untick to retire it: nothing new is charged with it)
              </label>
              <div className="flex justify-end">
                <Button type="submit" variant="outline" disabled={busy}>
                  {busy ? "Saving…" : "Save item"}
                </Button>
              </div>
            </form>

            <section aria-label="Prices" className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Prices</p>
              <ul className="divide-y divide-border text-sm">
                {item.history.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-2 py-2">
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono tabular-nums">{formatNumber(h.amount)} EGP</span>
                      <span className="text-muted-foreground">
                        from {day(h.effectiveFrom)} · {branchName(h.clinicId)}
                        {h.createdBy ? ` · ${h.createdBy}` : ""}
                      </span>
                      {h.scheduled ? <Badge tone="accent">Scheduled</Badge> : null}
                    </span>
                    {h.scheduled ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={busy}
                        onClick={() => void run(() => apiFetch(`/api/prices/${itemId}/prices/${h.id}`, { method: "DELETE" }), "Scheduled price withdrawn")}
                      >
                        Withdraw
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
              <form onSubmit={schedule} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end" noValidate aria-label="New price">
                <Field label="New price (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
                  <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label="From" htmlFor={`${id}-from`} hint={hint("effectiveFrom")}>
                  <Input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                {options.clinics.length > 1 ? (
                  <Field label="Branch" htmlFor={`${id}-branch`}>
                    <Select id={`${id}-branch`} value={branch} onChange={(e) => setBranch(e.target.value)}>
                      <option value="">Clinic-wide</option>
                      {options.clinics.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <span className="hidden sm:block" />
                )}
                <Button type="submit" disabled={busy || !amount.trim()}>
                  Set price
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">A price in force stays in the history; a scheduled one can be withdrawn until its day.</p>
            </section>
          </div>
        ) : error ? null : (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
