"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { ApiError, apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import { canonicalPhone, normalizeDigits } from "@/modules/patients/search";
import type { IntakeLanguage } from "@/modules/intake/form";
import type { PublicIntake } from "@/modules/intake/service";
import { INTAKE_COPY, treatmentLabel } from "@/components/clinicmind/intake-copy";

/**
 * The public onboarding form: five short steps, Arabic (RTL) or English,
 * mobile-first with large touch targets. Nothing is saved until the last
 * step; the submission goes to `POST /api/public/intake/[token]`.
 */

type Gender = "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";

interface FormState {
  fullName: string;
  phone: string;
  whatsappSame: boolean;
  whatsapp: string;
  dateOfBirth: string;
  gender: Gender;
  city: string;
  nationalId: string;
  email: string;
  address: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
  treatmentKeys: string[];
  concern: string;
  sinceWhen: string;
  chronicConditions: string[];
  allergies: string[];
  medications: { name: string; dose: string }[];
  surgeries: string[];
  consent: boolean;
  whatsappUpdates: boolean;
}

const STEP_FIELDS: (keyof FormState)[][] = [
  ["fullName", "phone", "whatsapp", "dateOfBirth", "gender", "city", "nationalId"],
  ["email", "address", "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation"],
  ["treatmentKeys", "concern", "sinceWhen"],
  ["chronicConditions", "allergies", "medications", "surgeries"],
  ["consent", "whatsappUpdates"],
];
const TOTAL_STEPS = 5;

function initialState(prefill: PublicIntake["prefill"]): FormState {
  const gender = (prefill?.gender ?? "UNDISCLOSED") as Gender;
  return {
    fullName: prefill?.fullName ?? "",
    phone: prefill?.phone ?? "",
    whatsappSame: !prefill?.whatsapp || prefill.whatsapp === prefill.phone,
    whatsapp: prefill?.whatsapp && prefill.whatsapp !== prefill.phone ? prefill.whatsapp : "",
    dateOfBirth: prefill?.dateOfBirth ?? "",
    gender: ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"].includes(gender) ? gender : "UNDISCLOSED",
    city: prefill?.city ?? "",
    nationalId: prefill?.nationalId ?? "",
    email: prefill?.email ?? "",
    address: prefill?.address ?? "",
    emergencyContactName: prefill?.emergencyContact ?? "",
    emergencyContactPhone: "",
    emergencyContactRelation: "",
    treatmentKeys: [],
    concern: "",
    sinceWhen: "",
    chronicConditions: [],
    allergies: [],
    medications: [],
    surgeries: [],
    consent: false,
    whatsappUpdates: true,
  };
}

const bigInput = "h-12 text-base";

export function IntakeForm({ token, intake }: { token: string; intake: PublicIntake }) {
  const id = useId();
  const [lang, setLang] = useState<IntakeLanguage>(intake.language);
  const copy = INTAKE_COPY[lang];
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [values, setValues] = useState<FormState>(() => initialState(intake.prefill));
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  function validateStep(index: number): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (index === 0) {
      if (values.fullName.trim().length < 2) next.fullName = copy.errors.name;
      if (!canonicalPhone(values.phone)) next.phone = copy.errors.phone;
      if (!values.whatsappSame && values.whatsapp.trim() && !canonicalPhone(values.whatsapp)) next.whatsapp = copy.errors.phone;
      if (values.dateOfBirth) {
        const t = Date.parse(`${normalizeDigits(values.dateOfBirth)}T00:00:00Z`);
        if (Number.isNaN(t) || t > Date.now()) next.dateOfBirth = copy.errors.date;
      }
    }
    if (index === 1) {
      if (values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) next.email = copy.errors.email;
      if (values.emergencyContactPhone.trim() && !canonicalPhone(values.emergencyContactPhone)) next.emergencyContactPhone = copy.errors.phone;
    }
    if (index === 4 && !values.consent) next.consent = copy.errors.consent;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function goNext() {
    if (!validateStep(step)) return;
    setFormError(null);
    setStep((s) => Math.min(TOTAL_STEPS - 1, s + 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function goBack() {
    setFormError(null);
    setStep((s) => Math.max(0, s - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validateStep(4)) return;
    setBusy(true);
    setFormError(null);
    try {
      await apiFetch(`/api/public/intake/${encodeURIComponent(token)}`, {
        method: "POST",
        body: {
          language: lang,
          fullName: values.fullName,
          phone: values.phone,
          whatsappSame: values.whatsappSame,
          whatsapp: values.whatsappSame ? "" : values.whatsapp,
          dateOfBirth: values.dateOfBirth,
          gender: values.gender,
          city: values.city,
          nationalId: values.nationalId,
          email: values.email,
          address: values.address,
          emergencyContactName: values.emergencyContactName,
          emergencyContactPhone: values.emergencyContactPhone,
          emergencyContactRelation: values.emergencyContactRelation,
          treatmentKeys: values.treatmentKeys,
          concern: values.concern,
          sinceWhen: values.sinceWhen,
          chronicConditions: values.chronicConditions,
          allergies: values.allergies,
          medications: values.medications.filter((m) => m.name.trim()),
          surgeries: values.surgeries,
          consent: values.consent,
          whatsappUpdates: values.whatsappUpdates,
        },
      });
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setFormError(copy.errors.expired);
      } else if (err instanceof ApiError && err.status === 429) {
        setFormError(copy.errors.tooMany);
      } else if (err instanceof ApiError && err.status === 422) {
        const fields = fieldErrors(err) as Partial<Record<keyof FormState, string>>;
        setErrors(fields);
        const firstBad = STEP_FIELDS.findIndex((keys) => keys.some((k) => fields[k]));
        if (firstBad >= 0) setStep(firstBad);
        setFormError(copy.errors.fix);
      } else {
        setFormError(copy.errors.generic);
      }
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof FormState) => errors[key];

  return (
    <div dir={copy.dir} lang={lang} className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold tracking-tight">{intake.clinicName}</p>
            <p className="truncate text-xs text-muted-foreground">{copy.title}</p>
          </div>
          <button
            type="button"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="h-10 shrink-0 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
            aria-label={copy.switchTo}
          >
            {copy.switchTo}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl px-4 py-5">
        {done ? (
          <div className="bento flex flex-col items-center gap-3 text-center" role="status">
            <CheckCircle2 className="h-12 w-12 text-success" aria-hidden="true" />
            <h1 className="font-display text-2xl font-semibold tracking-tight">{copy.done.title}</h1>
            <p className="text-sm text-muted-foreground">{copy.done.body}</p>
            <p className="text-xs text-muted-foreground">{copy.done.close}</p>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-4">
            <div>
              <p className="data-label">{copy.stepOf(step + 1, TOTAL_STEPS)}</p>
              <h1 className="mt-0.5 font-display text-xl font-semibold tracking-tight">{copy.steps[step]}</h1>
              {step === 0 ? <p className="mt-1 text-sm text-muted-foreground">{copy.intro}</p> : null}
              <ol className="mt-3 flex gap-1" aria-hidden="true">
                {copy.steps.map((label, i) => (
                  <li key={label} className={cn("h-1.5 flex-1 rounded-full", i <= step ? "bg-accent" : "bg-muted")} />
                ))}
              </ol>
            </div>

            {formError ? <Alert>{formError}</Alert> : null}

            <div className="bento space-y-4 p-4 sm:p-6">
              {step === 0 ? (
                <>
                  <Labelled id={`${id}-fullName`} label={copy.personal.fullName} error={field("fullName")}>
                    <Input id={`${id}-fullName`} className={bigInput} value={values.fullName} onChange={(e) => set("fullName", e.target.value)} maxLength={120} autoComplete="name" required aria-invalid={field("fullName") ? true : undefined} />
                  </Labelled>
                  <Labelled id={`${id}-phone`} label={copy.personal.phone} hint={copy.personal.phoneHint} error={field("phone")}>
                    <Input id={`${id}-phone`} className={cn(bigInput, "font-mono")} dir="ltr" type="tel" inputMode="tel" value={values.phone} onChange={(e) => set("phone", e.target.value)} maxLength={30} autoComplete="tel" required aria-invalid={field("phone") ? true : undefined} />
                  </Labelled>
                  <label className="flex min-h-12 items-center gap-3 rounded-lg border border-border px-3 text-sm">
                    <Checkbox className="h-5 w-5" checked={values.whatsappSame} onChange={(e) => set("whatsappSame", e.target.checked)} />
                    {copy.personal.whatsappSame}
                  </label>
                  {!values.whatsappSame ? (
                    <Labelled id={`${id}-whatsapp`} label={copy.personal.whatsapp} error={field("whatsapp")}>
                      <Input id={`${id}-whatsapp`} className={cn(bigInput, "font-mono")} dir="ltr" type="tel" inputMode="tel" value={values.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} maxLength={30} aria-invalid={field("whatsapp") ? true : undefined} />
                    </Labelled>
                  ) : null}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Labelled id={`${id}-dob`} label={copy.personal.dateOfBirth} optional={copy.optional} error={field("dateOfBirth")}>
                      <Input id={`${id}-dob`} className={bigInput} type="date" value={values.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} max={new Date().toISOString().slice(0, 10)} aria-invalid={field("dateOfBirth") ? true : undefined} />
                    </Labelled>
                    <Labelled id={`${id}-gender`} label={copy.personal.gender} error={field("gender")}>
                      <Select id={`${id}-gender`} className={bigInput} value={values.gender} onChange={(e) => set("gender", e.target.value as Gender)}>
                        {(Object.keys(copy.personal.genders) as Gender[]).map((g) => (
                          <option key={g} value={g}>
                            {copy.personal.genders[g]}
                          </option>
                        ))}
                      </Select>
                    </Labelled>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Labelled id={`${id}-city`} label={copy.personal.city} optional={copy.optional} error={field("city")}>
                      <Input id={`${id}-city`} className={bigInput} value={values.city} onChange={(e) => set("city", e.target.value)} maxLength={80} autoComplete="address-level2" />
                    </Labelled>
                    <Labelled id={`${id}-nid`} label={copy.personal.nationalId} optional={copy.optional} error={field("nationalId")}>
                      <Input id={`${id}-nid`} className={cn(bigInput, "font-mono")} dir="ltr" inputMode="numeric" value={values.nationalId} onChange={(e) => set("nationalId", e.target.value)} maxLength={40} autoComplete="off" />
                    </Labelled>
                  </div>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <Labelled id={`${id}-email`} label={copy.contact.email} optional={copy.optional} error={field("email")}>
                    <Input id={`${id}-email`} className={bigInput} dir="ltr" type="email" inputMode="email" value={values.email} onChange={(e) => set("email", e.target.value)} maxLength={254} autoComplete="email" aria-invalid={field("email") ? true : undefined} />
                  </Labelled>
                  <Labelled id={`${id}-address`} label={copy.contact.address} optional={copy.optional} error={field("address")}>
                    <Textarea id={`${id}-address`} className="min-h-[4.5rem] text-base" value={values.address} onChange={(e) => set("address", e.target.value)} maxLength={300} autoComplete="street-address" rows={2} />
                  </Labelled>
                  <fieldset className="space-y-4 rounded-lg border border-border p-4">
                    <legend className="px-1 text-sm font-medium">{copy.contact.emergencyTitle}</legend>
                    <p className="-mt-2 text-xs text-muted-foreground">{copy.contact.emergencyHint}</p>
                    <Labelled id={`${id}-ecName`} label={copy.contact.emergencyName} optional={copy.optional} error={field("emergencyContactName")}>
                      <Input id={`${id}-ecName`} className={bigInput} value={values.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} maxLength={120} autoComplete="off" />
                    </Labelled>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Labelled id={`${id}-ecPhone`} label={copy.contact.emergencyPhone} optional={copy.optional} error={field("emergencyContactPhone")}>
                        <Input id={`${id}-ecPhone`} className={cn(bigInput, "font-mono")} dir="ltr" type="tel" inputMode="tel" value={values.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} maxLength={30} autoComplete="off" aria-invalid={field("emergencyContactPhone") ? true : undefined} />
                      </Labelled>
                      <Labelled id={`${id}-ecRel`} label={copy.contact.emergencyRelation} hint={copy.contact.relationHint} optional={copy.optional} error={field("emergencyContactRelation")}>
                        <Input id={`${id}-ecRel`} className={bigInput} value={values.emergencyContactRelation} onChange={(e) => set("emergencyContactRelation", e.target.value)} maxLength={60} autoComplete="off" />
                      </Labelled>
                    </div>
                  </fieldset>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{copy.visit.treatments}</legend>
                    <p className="text-xs text-muted-foreground">{copy.visit.treatmentsHint}</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {intake.treatments.map((t) => {
                        const checked = values.treatmentKeys.includes(t.key);
                        return (
                          <label
                            key={t.key}
                            className={cn(
                              "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 text-sm transition-colors",
                              checked ? "border-accent bg-accent-muted text-accent" : "border-border hover:bg-muted",
                            )}
                          >
                            <Checkbox
                              className="h-5 w-5"
                              checked={checked}
                              onChange={(e) =>
                                set(
                                  "treatmentKeys",
                                  e.target.checked
                                    ? [...values.treatmentKeys, t.key].slice(0, 5)
                                    : values.treatmentKeys.filter((k) => k !== t.key),
                                )
                              }
                            />
                            {treatmentLabel(t.key, t.name, lang)}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <Labelled id={`${id}-concern`} label={copy.visit.concern} optional={copy.optional} error={field("concern")}>
                    <Textarea id={`${id}-concern`} className="min-h-[6rem] text-base" value={values.concern} onChange={(e) => set("concern", e.target.value)} maxLength={1000} placeholder={copy.visit.concernPlaceholder} rows={3} />
                  </Labelled>
                  <Labelled id={`${id}-since`} label={copy.visit.sinceWhen} hint={copy.visit.sinceWhenHint} optional={copy.optional} error={field("sinceWhen")}>
                    <Input id={`${id}-since`} className={bigInput} value={values.sinceWhen} onChange={(e) => set("sinceWhen", e.target.value)} maxLength={120} />
                  </Labelled>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <ChipList id={`${id}-chronic`} label={copy.history.chronic} hint={copy.history.chronicHint} values={values.chronicConditions} onChange={(v) => set("chronicConditions", v)} addLabel={copy.history.add} removeLabel={copy.history.remove} none={copy.history.none} />
                  <ChipList id={`${id}-allergies`} label={copy.history.allergies} hint={copy.history.allergiesHint} values={values.allergies} onChange={(v) => set("allergies", v)} addLabel={copy.history.add} removeLabel={copy.history.remove} none={copy.history.none} />
                  <MedicationList
                    id={`${id}-meds`}
                    label={copy.history.medications}
                    nameLabel={copy.history.medName}
                    doseLabel={copy.history.medDose}
                    addLabel={copy.history.addMedication}
                    removeLabel={copy.history.remove}
                    none={copy.history.none}
                    values={values.medications}
                    onChange={(v) => set("medications", v)}
                  />
                  <ChipList id={`${id}-surgeries`} label={copy.history.surgeries} hint={copy.history.surgeriesHint} values={values.surgeries} onChange={(v) => set("surgeries", v)} addLabel={copy.history.add} removeLabel={copy.history.remove} none={copy.history.none} />
                </>
              ) : null}

              {step === 4 ? (
                <>
                  <p className="text-sm text-muted-foreground">{copy.consent.review}</p>
                  <label className={cn("flex items-start gap-3 rounded-lg border p-3 text-sm", field("consent") ? "border-danger" : "border-border")}>
                    <Checkbox className="mt-0.5 h-5 w-5 shrink-0" checked={values.consent} onChange={(e) => set("consent", e.target.checked)} aria-invalid={field("consent") ? true : undefined} required />
                    <span>
                      <span className="font-medium">{copy.consent.processing}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{copy.consent.processingDetail}</span>
                    </span>
                  </label>
                  {field("consent") ? (
                    <p role="alert" className="text-xs text-danger">
                      {field("consent")}
                    </p>
                  ) : null}
                  <p className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground" data-testid="intake-ai-notice">
                    {copy.consent.ai}
                  </p>
                  <label className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
                    <Checkbox className="mt-0.5 h-5 w-5 shrink-0" checked={values.whatsappUpdates} onChange={(e) => set("whatsappUpdates", e.target.checked)} />
                    <span>{copy.consent.whatsappUpdates}</span>
                  </label>
                </>
              ) : null}
            </div>

            <div className="flex gap-3">
              {step > 0 ? (
                <Button type="button" variant="outline" size="lg" className="h-12 flex-1" onClick={goBack} disabled={busy}>
                  {copy.dir === "rtl" ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                  {copy.back}
                </Button>
              ) : null}
              {step < TOTAL_STEPS - 1 ? (
                <Button type="button" size="lg" className="h-12 flex-1" onClick={goNext}>
                  {copy.next}
                  {copy.dir === "rtl" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              ) : (
                <Button type="submit" size="lg" className="h-12 flex-1" disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {busy ? copy.sending : copy.submit}
                </Button>
              )}
            </div>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          {copy.poweredBy} {intake.productName}
        </p>
      </main>
    </div>
  );
}

function Labelled({
  id,
  label,
  hint,
  optional,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  optional?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {optional ? <span className="ms-1 text-xs font-normal text-muted-foreground">({optional})</span> : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Short list entry (chips) with an input and an Add button; Enter adds too. */
function ChipList({
  id,
  label,
  hint,
  values,
  onChange,
  addLabel,
  removeLabel,
  none,
  max = 30,
}: {
  id: string;
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  addLabel: string;
  removeLabel: string;
  none: string;
  max?: number;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const value = draft.trim().replace(/\s+/g, " ");
    setDraft("");
    if (!value || values.length >= max || values.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    onChange([...values, value]);
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          className={bigInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          maxLength={120}
          placeholder={hint}
          autoComplete="off"
        />
        <Button type="button" variant="outline" size="lg" className="h-12 shrink-0" onClick={add} disabled={!draft.trim()}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
      {values.length ? (
        <ul className="flex flex-wrap gap-2">
          {values.map((value) => (
            <li key={value} className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-muted px-2.5 py-1.5 text-sm text-accent">
              <span className="truncate">{value}</span>
              <button type="button" onClick={() => onChange(values.filter((v) => v !== value))} aria-label={`${removeLabel}: ${value}`} className="rounded-sm p-0.5 hover:bg-accent/20">
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{none}</p>
      )}
    </div>
  );
}

function MedicationList({
  id,
  label,
  nameLabel,
  doseLabel,
  addLabel,
  removeLabel,
  none,
  values,
  onChange,
}: {
  id: string;
  label: string;
  nameLabel: string;
  doseLabel: string;
  addLabel: string;
  removeLabel: string;
  none: string;
  values: { name: string; dose: string }[];
  onChange: (values: { name: string; dose: string }[]) => void;
}) {
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  function add() {
    const n = name.trim();
    if (!n || values.length >= 30) return;
    onChange([...values, { name: n, dose: dose.trim() }]);
    setName("");
    setDose("");
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem_auto]">
        <Input id={`${id}-name`} className={bigInput} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={nameLabel} aria-label={nameLabel} autoComplete="off" />
        <Input id={`${id}-dose`} className={bigInput} value={dose} onChange={(e) => setDose(e.target.value)} maxLength={80} placeholder={doseLabel} aria-label={doseLabel} autoComplete="off" />
        <Button type="button" variant="outline" size="lg" className="h-12" onClick={add} disabled={!name.trim()}>
          <Plus className="h-4 w-4" />
          {addLabel}
        </Button>
      </div>
      {values.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {values.map((m, i) => (
            <li key={`${m.name}-${i}`} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{m.name}</span>
                {m.dose ? <span className="text-muted-foreground"> · {m.dose}</span> : null}
              </span>
              <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`${removeLabel}: ${m.name}`} className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{none}</p>
      )}
    </div>
  );
}
