"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/primitives";
import { PatientPicker, type PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { apiFetch } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  DISCOUNT_REASON_LABELS,
  DISCOUNT_REASONS,
  PRICE_CATEGORIES,
  unitPhrase,
  withinDiscountLimit,
  type DiscountReasonValue,
} from "@/modules/finance/constants";
import { stagesFor } from "@/modules/finance/charges";
import { countedUnit, MAX_ITEMS, MAX_PHASES, QUOTE_VALID_DAYS } from "@/modules/quotes/constants";
import { unitWord } from "@/modules/quotes/copy";
import { financeErrorMessage, toPriceOptions, type DoctorOption, type PriceOption } from "./finance-shared";

export interface QuoteDraftItem {
  /** On the draft already (its discount, unchanged, keeps who gave it). */
  id?: string;
  priceItemId: string;
  quantity: number;
  site: string;
  discount: number;
  discountReason: DiscountReasonValue | "";
  discountNote: string;
}

export interface QuoteDraftValues {
  patient: PatientOption | null;
  clinicId: string;
  doctorId: string;
  /** "" : the patient's own language. */
  language: "" | "en" | "ar";
  title: string;
  note: string;
  validUntil: string;
  phases: { title: string; items: QuoteDraftItem[] }[];
}

interface Row extends QuoteDraftItem {
  key: string;
}

const emptyItem = (key: string): Row => ({ key, priceItemId: "", quantity: 1, site: "", discount: 0, discountReason: "", discountNote: "" });

/**
 * The treatment plan editor: the patient, the branch it is priced at, the
 * doctor, its language, heading and last valid day, then its phases, each
 * with treatments from the price list (how many of the unit, where, a
 * discount within the role's limit with its reason). Prices are today's for
 * the branch; the totals follow every change. Saving keeps it a draft.
 */
export function QuoteEditor({
  quoteId,
  initial,
  clinics,
  doctors,
  priceItems,
  discountLimit,
  todayKey,
}: {
  /** Editing this draft; a new one otherwise. */
  quoteId?: string;
  initial: QuoteDraftValues;
  clinics: { id: string; name: string }[];
  doctors: DoctorOption[];
  /** The price list as of today for the initial branch. */
  priceItems: PriceOption[];
  /** The largest discount the user's role may give, as a percentage of the price. */
  discountLimit: number;
  todayKey: string;
}) {
  const id = useId();
  const router = useRouter();
  const [patient, setPatient] = useState<PatientOption | null>(initial.patient);
  const [clinicId, setClinicId] = useState(initial.clinicId);
  const [doctorId, setDoctorId] = useState(initial.doctorId);
  const [language, setLanguage] = useState(initial.language);
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [validUntil, setValidUntil] = useState(initial.validUntil);
  // Keys the same on the server and in the browser (the inputs' ids are made from them); rows added later count on.
  const [phases, setPhases] = useState(() => initial.phases.map((p, i) => ({ key: `p${i}`, title: p.title, items: p.items.map((item, j): Row => ({ ...item, key: `p${i}-${j}` })) })));
  const added = useRef(0);
  const nextKey = () => `n${++added.current}`;
  const [options, setOptions] = useState(priceItems);
  // Checked as the fields change once a save was tried: a fixed field loses its message at once.
  const [tried, setTried] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Discounts as they were saved: kept as they are, whoever gave them.
  const [given] = useState(() => new Map(initial.phases.flatMap((p) => p.items).filter((i) => i.id).map((i) => [i.id!, i])));
  const loadedBranch = useRef(initial.clinicId);

  useEffect(() => {
    if (!clinicId || clinicId === loadedBranch.current) return;
    let live = true;
    apiFetch<{ items: Parameters<typeof toPriceOptions>[0] }>(`/api/prices?clinicId=${encodeURIComponent(clinicId)}`)
      .then((res) => {
        if (!live) return;
        loadedBranch.current = clinicId;
        setOptions(toPriceOptions(res.items));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [clinicId]);

  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const grouped = useMemo(() => PRICE_CATEGORIES.map((c) => ({ category: c, items: options.filter((o) => o.category === c) })).filter((g) => g.items.length), [options]);

  const priced = (row: Row) => {
    const item = byId.get(row.priceItemId) ?? null;
    const quantity = item && countedUnit(item.unit) ? Math.max(1, Math.floor(row.quantity) || 1) : 1;
    const price = item?.price !== null && item?.price !== undefined ? item.price * quantity : null;
    return { item, quantity, price, stages: item ? stagesFor(item, quantity) : 1, net: price === null ? null : price - row.discount };
  };
  const rows = phases.flatMap((p) => p.items);
  const totals = rows.reduce(
    (t, r) => {
      const { price } = priced(r);
      return price === null ? t : { list: t.list + price, discount: t.discount + r.discount, total: t.total + price - r.discount };
    },
    { list: 0, discount: 0, total: 0 },
  );

  const setPhase = (key: string, change: (p: (typeof phases)[number]) => (typeof phases)[number]) => setPhases((all) => all.map((p) => (p.key === key ? change(p) : p)));
  const setRow = (phaseKey: string, rowKey: string, change: Partial<Row>) => setPhase(phaseKey, (p) => ({ ...p, items: p.items.map((r) => (r.key === rowKey ? { ...r, ...change } : r)) }));

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!patient) next.patient = "Choose the patient.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || validUntil < todayKey) next.validUntil = "Today or later.";
    if (!phases.length) next.phases = "Add a phase.";
    for (const p of phases) {
      if (!p.title.trim()) next[`${p.key}.title`] = "Give the phase a heading.";
      if (!p.items.length) next[`${p.key}.items`] = "Add at least one treatment.";
      for (const r of p.items) {
        const { item, price } = priced(r);
        if (!item) {
          next[`${r.key}.item`] = "Choose a treatment from the price list.";
          continue;
        }
        if (price === null) next[`${r.key}.item`] = "No price on the list today.";
        if (!Number.isInteger(r.discount) || r.discount < 0) next[`${r.key}.discount`] = "Whole EGP.";
        else if (price !== null && r.discount > price) next[`${r.key}.discount`] = "Not more than the price.";
        else if (price !== null && r.discount > 0) {
          const before = r.id ? given.get(r.id) : undefined;
          const unchanged = before && before.priceItemId === r.priceItemId && before.discount === r.discount && before.discountReason === r.discountReason && before.discountNote === r.discountNote;
          if (!unchanged && !withinDiscountLimit(price, r.discount, discountLimit)) {
            next[`${r.key}.discount`] = discountLimit > 0 ? `Up to ${discountLimit}% (${formatNumber(Math.floor((price * discountLimit) / 100))} EGP) for your role; more needs the clinic owner.` : "Discounts are given by the clinic owner.";
          }
          if (!r.discountReason) next[`${r.key}.reason`] = "Why is it discounted?";
          else if (r.discountReason === "OTHER" && !r.discountNote.trim()) next[`${r.key}.note`] = "Say why.";
        }
      }
    }
    return next;
  }

  const errors = tried ? validate() : {};
  const invalid = Object.keys(errors).length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setFailure(null);
    if (Object.keys(validate()).length) return;
    const body = {
      clinicId,
      doctorId: doctorId || (quoteId ? null : undefined),
      language: language || undefined,
      title: title.trim() || (quoteId ? null : undefined),
      note: note.trim() || (quoteId ? null : undefined),
      validUntil,
      phases: phases.map((p) => ({
        title: p.title.trim(),
        items: p.items.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          priceItemId: r.priceItemId,
          quantity: priced(r).quantity,
          ...(r.site.trim() ? { site: r.site.trim() } : {}),
          discount: r.discount,
          ...(r.discount > 0 && r.discountReason ? { discountReason: r.discountReason } : {}),
          ...(r.discount > 0 && r.discountReason === "OTHER" ? { discountNote: r.discountNote.trim() } : {}),
        })),
      })),
    };
    setBusy(true);
    try {
      const res = quoteId
        ? await apiFetch<{ quote: { id: string } }>(`/api/quotes/${quoteId}`, { method: "PATCH", body })
        : await apiFetch<{ quote: { id: string } }>("/api/quotes", { method: "POST", body: { ...body, patientId: patient!.id } });
      router.push(`/dashboard/quotes/${res.quote.id}`);
      router.refresh();
    } catch (err) {
      setFailure(financeErrorMessage(err));
      setBusy(false);
    }
  }

  const count = rows.length;
  return (
    <form onSubmit={save} className="space-y-4" noValidate aria-label={quoteId ? "Edit the treatment plan" : "New treatment plan"}>
      <Card className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="sm:col-span-2 lg:col-span-1">
          {quoteId ? (
            <Field label="Patient" htmlFor={`${id}-patient`}>
              <p id={`${id}-patient`} className="flex h-10 items-center text-sm font-medium">
                {patient?.fullName}
              </p>
            </Field>
          ) : (
            <PatientPicker value={patient} onChange={setPatient} error={errors.patient} />
          )}
        </div>
        {clinics.length > 1 ? (
          <Field label="Branch" htmlFor={`${id}-branch`} hint="Its prices, and the quote's number.">
            <Select id={`${id}-branch`} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Doctor" htmlFor={`${id}-doctor`} hint="The accepted treatments are theirs.">
          <Select id={`${id}-doctor`} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
            <option value="">No doctor named</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Language" htmlFor={`${id}-language`} hint="Printed and sent in it.">
          <Select id={`${id}-language`} value={language} onChange={(e) => setLanguage(e.target.value as QuoteDraftValues["language"])}>
            {quoteId ? null : <option value="">The patient&apos;s language</option>}
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </Select>
        </Field>
        <Field label="Heading (optional)" htmlFor={`${id}-title`} hint="Otherwise: Treatment plan and quote.">
          <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. Hair restoration plan" />
        </Field>
        <Field label="Valid until" htmlFor={`${id}-valid`} hint={errors.validUntil ?? `The last day it can be accepted (${QUOTE_VALID_DAYS} days unless changed).`}>
          <Input id={`${id}-valid`} type="date" value={validUntil} min={todayKey} onChange={(e) => setValidUntil(e.target.value)} aria-invalid={errors.validUntil ? true : undefined} />
        </Field>
      </Card>

      {phases.map((phase, p) => (
        <Card key={phase.key} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <Field label={`Phase ${p + 1}`} htmlFor={`${id}-${phase.key}-title`} hint={errors[`${phase.key}.title`] ?? errors[`${phase.key}.items`]}>
                <Input id={`${id}-${phase.key}-title`} value={phase.title} onChange={(e) => setPhase(phase.key, (x) => ({ ...x, title: e.target.value }))} maxLength={80} placeholder="e.g. Months 1–3: control the acne" aria-invalid={errors[`${phase.key}.title`] ? true : undefined} />
              </Field>
            </div>
            {phases.length > 1 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPhases((all) => all.filter((x) => x.key !== phase.key))}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Remove phase
              </Button>
            ) : null}
          </div>

          <ul className="space-y-3">
            {phase.items.map((row) => {
              const { item, quantity, price, stages, net } = priced(row);
              const rowId = `${id}-${row.key}`;
              return (
                <li key={row.key} className="space-y-3 rounded-md border border-border p-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <Field label="Treatment" htmlFor={`${rowId}-item`} hint={errors[`${row.key}.item`] ?? (item ? `${item.code} · ${unitPhrase(item.unit, item.unitLabel, item.sessions)}${item.price !== null ? ` · ${formatNumber(item.price)} EGP` : ""}` : undefined)}>
                      <Select id={`${rowId}-item`} value={row.priceItemId} onChange={(e) => setRow(phase.key, row.key, { priceItemId: e.target.value, quantity: 1 })} aria-invalid={errors[`${row.key}.item`] ? true : undefined}>
                        <option value="">Choose from the price list</option>
                        {grouped.map((g) => (
                          <optgroup key={g.category} label={CATEGORY_LABELS[g.category]}>
                            {g.items.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                                {o.price !== null ? ` — ${formatNumber(o.price)} EGP` : " — no price"}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </Select>
                    </Field>
                    {item && countedUnit(item.unit) ? (
                      <Field label={`How many ${unitWord(item.unit, item.unitLabel, 2, "en")}`} htmlFor={`${rowId}-qty`}>
                        <Input id={`${rowId}-qty`} type="number" inputMode="numeric" min={1} max={10_000} value={row.quantity} onChange={(e) => setRow(phase.key, row.key, { quantity: Math.max(1, Math.min(10_000, Math.floor(Number(e.target.value) || 1))) })} />
                      </Field>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Where (optional)" htmlFor={`${rowId}-site`}>
                      <Input id={`${rowId}-site`} value={row.site} onChange={(e) => setRow(phase.key, row.key, { site: e.target.value })} maxLength={80} placeholder="e.g. Crown, both cheeks" />
                    </Field>
                    <Field label="Discount (EGP)" htmlFor={`${rowId}-discount`} hint={errors[`${row.key}.discount`]}>
                      <Input
                        id={`${rowId}-discount`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={row.discount}
                        onChange={(e) => setRow(phase.key, row.key, { discount: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                        aria-invalid={errors[`${row.key}.discount`] ? true : undefined}
                      />
                    </Field>
                    {row.discount > 0 ? (
                      <Field label="Why" htmlFor={`${rowId}-reason`} hint={errors[`${row.key}.reason`]}>
                        <Select id={`${rowId}-reason`} value={row.discountReason} onChange={(e) => setRow(phase.key, row.key, { discountReason: e.target.value as DiscountReasonValue | "" })} aria-invalid={errors[`${row.key}.reason`] ? true : undefined}>
                          <option value="">Choose a reason</option>
                          {DISCOUNT_REASONS.map((r) => (
                            <option key={r} value={r}>
                              {DISCOUNT_REASON_LABELS[r]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                  {row.discount > 0 && row.discountReason === "OTHER" ? (
                    <Field label="The reason, in words" htmlFor={`${rowId}-note`} hint={errors[`${row.key}.note`]}>
                      <Input id={`${rowId}-note`} value={row.discountNote} onChange={(e) => setRow(phase.key, row.key, { discountNote: e.target.value })} maxLength={300} aria-invalid={errors[`${row.key}.note`] ? true : undefined} />
                    </Field>
                  ) : null}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      {item && price !== null
                        ? `${countedUnit(item.unit) && quantity > 1 ? `${formatNumber(item.price ?? 0)} × ${formatNumber(quantity)} = ` : ""}${formatNumber(price)} EGP${row.discount > 0 ? ` − ${formatNumber(row.discount)}` : ""}${stages > 1 ? ` · ${stages} sessions, each charged as it is done` : ""}`
                        : "—"}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium tabular-nums text-foreground">{net !== null ? `${formatNumber(net)} EGP` : ""}</span>
                      <Button type="button" variant="ghost" size="sm" aria-label="Remove this treatment" onClick={() => setPhase(phase.key, (x) => ({ ...x, items: x.items.filter((r) => r.key !== row.key) }))}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          <Button type="button" variant="outline" size="sm" disabled={count >= MAX_ITEMS} onClick={() => setPhase(phase.key, (x) => ({ ...x, items: [...x.items, emptyItem(nextKey())] }))}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a treatment
          </Button>
        </Card>
      ))}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={phases.length >= MAX_PHASES} onClick={() => setPhases((all) => [...all, { key: nextKey(), title: "", items: [emptyItem(nextKey())] }])}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a phase
        </Button>
      </div>

      <Card className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Field label="Note on the quote (optional)" htmlFor={`${id}-note`} hint="Printed on it: what is included, what to bring…">
          <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-[5rem]" />
        </Field>
        <dl className="space-y-1 self-end text-sm">
          <div className="flex justify-between gap-4 text-muted-foreground">
            <dt>Before discounts</dt>
            <dd className="font-mono tabular-nums">{formatNumber(totals.list)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-muted-foreground">
            <dt>Discounts</dt>
            <dd className="font-mono tabular-nums">−{formatNumber(totals.discount)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
            <dt>Total (EGP)</dt>
            <dd className="font-mono tabular-nums" data-testid="editor-total">
              {formatNumber(totals.total)}
            </dd>
          </div>
        </dl>
      </Card>

      {invalid ? <Alert>Please check the highlighted fields.</Alert> : failure ? <Alert>{failure}</Alert> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {busy ? "Saving…" : "Save the draft"}
        </Button>
        <p className="text-xs text-muted-foreground">A draft has no number yet: it is numbered when given to the patient, and from then on its prices hold.</p>
      </div>
    </form>
  );
}
