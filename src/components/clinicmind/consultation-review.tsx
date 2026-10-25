"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { CalendarCheck, Loader2, Plus, ShieldCheck, Trash2, Unlink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import { cn, formatDate, formatTime } from "@/lib/utils";
import { normaliseClinicalTerm } from "@/modules/consultations/normalise";
import {
  EXTRACTION_LIMITS,
  SUMMARY_MAX_LENGTH,
  type ActiveMedication,
  type AppointmentOption,
  type ClinicalExtraction,
  type SignResponse,
} from "@/modules/consultations/types";

type ListKey = "symptoms" | "diagnoses" | "tests" | "followUps";

const LIST_SECTIONS: { key: ListKey; label: string; placeholder: string }[] = [
  { key: "symptoms", label: "Symptoms", placeholder: "Add a symptom, press Enter" },
  { key: "diagnoses", label: "Diagnoses", placeholder: "Add a diagnosis, press Enter" },
  { key: "tests", label: "Tests ordered", placeholder: "Add a test, press Enter" },
  { key: "followUps", label: "Follow-ups", placeholder: "Add a follow-up, press Enter" },
];

interface MedicationRow {
  key: number;
  name: string;
  dosage: string;
  frequency: string;
}

let medicationKeySeq = 0;
const nextMedicationKey = () => ++medicationKeySeq;

export interface ConsultationReviewProps {
  consultationId: string;
  patient: { id: string; fullName: string };
  /** The AI draft: the baseline the edit count (and the audit row) compare against. */
  draft: ClinicalExtraction;
  draftSummary: string;
  appointment: AppointmentOption | null;
  /** Nothing could be extracted: the editor starts blank on purpose and says so. */
  empty: boolean;
  canDiscard: boolean;
  onSigned: (result: SignResponse) => void;
  /** The draft is gone (discarded, or no longer pending): leave the review. */
  onClosed: () => void;
  onNew: () => void;
}

/**
 * Review step: every section of the AI draft is editable — chip lists for
 * symptoms / diagnoses / tests / follow-ups, rows for medications, a checklist
 * to stop the patient's current medications, and the visit summary. Nothing
 * is saved until the clinician confirms the signature.
 */
export function ConsultationReview(props: ConsultationReviewProps) {
  const { consultationId, patient, draft, draftSummary, empty, canDiscard, onSigned, onClosed, onNew } = props;
  const { toast } = useToast();

  const [lists, setLists] = useState<Record<ListKey, string[]>>(() => ({
    symptoms: [...draft.symptoms],
    diagnoses: [...draft.diagnoses],
    tests: [...draft.tests],
    followUps: [...draft.followUps],
  }));
  const [medications, setMedications] = useState<MedicationRow[]>(() =>
    draft.medications.map((m) => ({
      key: nextMedicationKey(),
      name: m.name,
      dosage: m.dosage ?? "",
      frequency: m.frequency ?? "",
    })),
  );
  const [summary, setSummary] = useState(draftSummary);
  const [appointment, setAppointment] = useState(props.appointment);
  const [stopIds, setStopIds] = useState<ReadonlySet<string>>(() => new Set());
  const [activeMedications, setActiveMedications] = useState<ActiveMedication[] | null>(null);
  const [medicationsError, setMedicationsError] = useState<string | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [signed, setSigned] = useState<SignResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ medications: ActiveMedication[] }>(`/api/consultations/patient/${patient.id}/medications`)
      .then((data) => {
        if (!cancelled) setActiveMedications(data.medications);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setMedicationsError(err instanceof Error ? err.message : "Could not load current medications.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [patient.id]);

  const edits = useMemo(
    () => countEdits(draft, draftSummary, lists, medications, summary),
    [draft, draftSummary, lists, medications, summary],
  );
  const prescribedNames = useMemo(
    () => new Set(medications.map((m) => normaliseClinicalTerm(m.name)).filter(Boolean)),
    [medications],
  );
  const blankMedicationRows = medications.filter((m) => !m.name.trim()).length;
  const nothingEntered = LIST_SECTIONS.every((s) => lists[s.key].length === 0) && medications.length === 0;

  function setList(key: ListKey, items: string[]) {
    setLists((prev) => ({ ...prev, [key]: items }));
  }

  function toggleStop(id: string) {
    setStopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function buildExtraction(): ClinicalExtraction {
    return {
      symptoms: lists.symptoms,
      diagnoses: lists.diagnoses,
      tests: lists.tests,
      followUps: lists.followUps,
      medications: medications
        .filter((m) => m.name.trim())
        .map((m) => ({
          name: m.name.trim(),
          ...(m.dosage.trim() ? { dosage: m.dosage.trim() } : {}),
          ...(m.frequency.trim() ? { frequency: m.frequency.trim() } : {}),
        })),
    };
  }

  async function sign() {
    setBusy(true);
    setFormError(null);
    try {
      const result = await apiFetch<SignResponse>(`/api/consultations/${consultationId}/sign`, {
        method: "POST",
        body: {
          summary: summary.trim(),
          extraction: buildExtraction(),
          appointmentId: appointment?.id,
          stopMedicationIds: [...stopIds],
        },
      });
      setSignOpen(false);
      setSigned(result);
      toast({ title: "Consultation signed", description: `Saved to ${patient.fullName}'s record.`, tone: "success" });
      onSigned(result);
    } catch (err) {
      setSignOpen(false);
      if (err instanceof ApiError && err.status === 409 && err.code === "appointment_already_signed") {
        setFormError("That appointment already has a signed visit. Unlink it to sign this consultation on its own.");
      } else if (err instanceof ApiError && err.status === 409) {
        toast({ title: "This consultation is no longer pending review", tone: "danger" });
        onClosed();
      } else if (err instanceof ApiError && err.status === 422) {
        const errors = fieldErrors(err);
        setFormError(Object.values(errors)[0] ?? err.message);
      } else if (err instanceof ApiError && err.status === 404) {
        setFormError(
          "Something referenced here no longer exists (the patient, the appointment or a medication). Reload and try again.",
        );
      } else {
        setFormError(err instanceof Error ? err.message : "Could not sign the consultation.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (signed) return <SignedState result={signed} patient={patient} onNew={onNew} />;

  const signedMedicationCount = medications.filter((m) => m.name.trim()).length;
  const confirmDescription = [
    `You are signing this into ${patient.fullName}'s record:`,
    `${lists.diagnoses.length} ${plural(lists.diagnoses.length, "diagnosis", "diagnoses")},`,
    `${signedMedicationCount} ${plural(signedMedicationCount, "medication", "medications")}`,
    stopIds.size ? `and ${stopIds.size} stopped,` : "",
    appointment ? "with the linked appointment marked completed." : "",
    "The visit becomes part of the patient's history and cannot be unsigned.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className="space-y-5">
      <SectionTitle
        title="Review & sign"
        description={`${patient.fullName} — every section is editable. Nothing is saved until you sign.`}
        action={
          <Badge tone={edits ? "warning" : "default"}>
            {edits ? `${edits} ${plural(edits, "edit", "edits")} from AI draft` : "matches AI draft"}
          </Badge>
        }
      />

      {empty && nothingEntered ? (
        <Alert tone="info">
          No structured data could be extracted from this transcript. Nothing was inferred — enter the findings
          below before signing.
        </Alert>
      ) : null}

      {appointment ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <CalendarCheck className="h-4 w-4 shrink-0 text-accent" />
            <span className="min-w-0">
              Linked appointment:{" "}
              <span className="font-medium">
                {formatDate(appointment.startsAt)} {formatTime(appointment.startsAt)}
              </span>
              {appointment.reason ? ` — ${appointment.reason}` : ""}
              <span className="block text-xs text-muted-foreground">Marked completed when you sign.</span>
            </span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAppointment(null)}>
            <Unlink />
            Unlink
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {LIST_SECTIONS.map((section) => (
          <ChipList
            key={section.key}
            id={`review-${section.key}`}
            label={section.label}
            placeholder={section.placeholder}
            items={lists[section.key]}
            onChange={(items) => setList(section.key, items)}
          />
        ))}
      </div>

      <MedicationEditor rows={medications} onChange={setMedications} />

      <div className="space-y-2">
        <p className="data-label">Stop existing medication</p>
        <StopMedicationList
          medications={activeMedications}
          error={medicationsError}
          selected={stopIds}
          prescribedNames={prescribedNames}
          onToggle={toggleStop}
        />
        <p className="text-xs text-muted-foreground">
          Ticked medications are stopped when you sign. A current medication that also appears in the
          prescription above is updated in place — unless it is ticked, in which case the current entry is
          stopped and a fresh one started.
        </p>
      </div>

      <Field
        label="Visit summary"
        htmlFor="review-summary"
        hint={
          <span className="flex justify-between gap-4">
            <span>Signed into the visit record.</span>
            <span className="font-mono tabular-nums">
              {summary.length.toLocaleString()} / {SUMMARY_MAX_LENGTH.toLocaleString()}
            </span>
          </span>
        }
      >
        <DictationField onDictated={setSummary} disabled={busy}>
          <Textarea
            id="review-summary"
            rows={5}
            maxLength={SUMMARY_MAX_LENGTH}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Summarise the visit for the record…"
          />
        </DictationField>
      </Field>

      {blankMedicationRows ? (
        <Alert>
          Every medication needs a name — fill in or remove the{" "}
          {blankMedicationRows === 1 ? "empty row" : `${blankMedicationRows} empty rows`}.
        </Alert>
      ) : null}
      {formError ? <Alert>{formError}</Alert> : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        {canDiscard ? <DiscardButton consultationId={consultationId} disabled={busy} onDone={onClosed} /> : <span />}
        <Button type="button" onClick={() => setSignOpen(true)} disabled={busy || blankMedicationRows > 0}>
          {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Review complete — sign
        </Button>
      </div>

      <ConfirmDialog
        open={signOpen}
        onOpenChange={setSignOpen}
        title="Sign this consultation?"
        description={confirmDescription}
        confirmLabel="Sign into record"
        busy={busy}
        onConfirm={sign}
      />
    </Card>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function ChipList({
  id,
  label,
  placeholder,
  items,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const full = items.length >= EXTRACTION_LIMITS.items;

  function add() {
    const value = draft.trim().replace(/\s+/g, " ");
    if (!value || full) return;
    const key = normaliseClinicalTerm(value);
    if (!items.some((item) => normaliseClinicalTerm(item) === key)) onChange([...items, value]);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      add();
    }
  }

  return (
    <Field label={label} htmlFor={id} hint={full ? `Maximum ${EXTRACTION_LIMITS.items} items.` : undefined}>
      <div className="rounded-lg border border-input bg-background p-2">
        {items.length ? (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label={label}>
            {items.map((item) => (
              <li key={item}>
                <Chip text={item} onRemove={() => onChange(items.filter((x) => x !== item))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-2 px-1 text-xs text-muted-foreground">None.</p>
        )}
        <div className="flex gap-2">
          <Input
            id={id}
            value={draft}
            placeholder={placeholder}
            maxLength={EXTRACTION_LIMITS.itemLength}
            disabled={full}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-9"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={add}
            disabled={!draft.trim() || full}
            aria-label={`Add to ${label}`}
          >
            <Plus />
            Add
          </Button>
        </div>
      </div>
    </Field>
  );
}

export function Chip({ text, onRemove }: { text: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs font-medium text-accent">
      <span className="truncate">{text}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${text}`}
          className="rounded p-0.5 hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

function MedicationEditor({ rows, onChange }: { rows: MedicationRow[]; onChange: (rows: MedicationRow[]) => void }) {
  function update(key: number, patch: Partial<MedicationRow>) {
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <fieldset className="space-y-2">
      <legend className="data-label mb-1.5">Medications</legend>
      {rows.length ? (
        <div className="hidden grid-cols-[2fr_1fr_1fr_2.25rem] gap-2 px-1 sm:grid" aria-hidden="true">
          <span className="data-label">Name</span>
          <span className="data-label">Dosage</span>
          <span className="data-label">Frequency</span>
          <span />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No medications in this consultation.</p>
      )}
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[2fr_1fr_1fr_2.25rem] sm:border-0 sm:p-0">
          <Input
            aria-label="Medication name"
            placeholder="Name"
            value={row.name}
            maxLength={EXTRACTION_LIMITS.medicationName}
            onChange={(e) => update(row.key, { name: e.target.value })}
            className="h-9"
          />
          <Input
            aria-label="Dosage"
            placeholder="Dosage, e.g. 500 mg"
            value={row.dosage}
            maxLength={EXTRACTION_LIMITS.medicationField}
            onChange={(e) => update(row.key, { dosage: e.target.value })}
            className="h-9"
          />
          <Input
            aria-label="Frequency"
            placeholder="Frequency, e.g. twice daily"
            value={row.frequency}
            maxLength={EXTRACTION_LIMITS.medicationField}
            onChange={(e) => update(row.key, { frequency: e.target.value })}
            className="h-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 justify-self-start px-2 text-danger hover:bg-danger/10 sm:justify-self-auto"
            aria-label={`Remove ${row.name.trim() || "medication"}`}
            onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
          >
            <Trash2 />
            <span className="sm:sr-only">Remove</span>
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: nextMedicationKey(), name: "", dosage: "", frequency: "" }])}
        disabled={rows.length >= EXTRACTION_LIMITS.items}
      >
        <Plus />
        Add medication
      </Button>
    </fieldset>
  );
}

function StopMedicationList({
  medications,
  error,
  selected,
  prescribedNames,
  onToggle,
}: {
  medications: ActiveMedication[] | null;
  error: string | null;
  selected: ReadonlySet<string>;
  prescribedNames: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (error) return <Alert tone="info">{error}</Alert>;
  if (medications === null) return <p className="text-xs text-muted-foreground">Loading current medications…</p>;
  if (!medications.length) return <p className="text-xs text-muted-foreground">No active medications on record.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {medications.map((m) => {
        const checked = selected.has(m.id);
        const inPrescription = prescribedNames.has(normaliseClinicalTerm(m.name));
        const details = [m.dosage, m.frequency].filter(Boolean).join(" · ");
        return (
          <li key={m.id}>
            <label
              htmlFor={`stop-${m.id}`}
              className={cn("flex cursor-pointer items-start gap-3 px-3 py-2 text-sm", checked && "bg-danger/5")}
            >
              <Checkbox id={`stop-${m.id}`} checked={checked} onChange={() => onToggle(m.id)} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className={cn("font-medium", checked && "line-through")}>{m.name}</span>
                {details ? <span className="text-muted-foreground"> · {details}</span> : null}
                {m.startDate ? (
                  <span className="block font-mono text-[11px] text-muted-foreground">since {formatDate(m.startDate)}</span>
                ) : null}
              </span>
              {inPrescription ? <Badge tone="accent">in prescription</Badge> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Discard a pending draft after confirmation. Shared with the read-only view. */
export function DiscardButton({
  consultationId,
  disabled = false,
  onDone,
}: {
  consultationId: string;
  disabled?: boolean;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function discard() {
    setBusy(true);
    try {
      await apiFetch(`/api/consultations/${consultationId}/discard`, { method: "POST" });
      setOpen(false);
      toast({ title: "Draft discarded", description: "Nothing was written to the patient record.", tone: "info" });
      onDone();
    } catch (err) {
      setOpen(false);
      if (err instanceof ApiError && err.status === 409) {
        toast({ title: "This consultation is no longer pending review", tone: "danger" });
        onDone();
      } else {
        toast({
          title: "Could not discard the draft",
          description: err instanceof Error ? err.message : undefined,
          tone: "danger",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger/10"
        onClick={() => setOpen(true)}
        disabled={disabled || busy}
      >
        <Trash2 />
        Discard draft
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Discard this draft?"
        description="The transcript and the AI draft stay in the audit trail, but nothing is written to the patient's record. This cannot be undone."
        confirmLabel="Discard"
        tone="danger"
        busy={busy}
        onConfirm={discard}
      />
    </>
  );
}

function SignedState({
  result,
  patient,
  onNew,
}: {
  result: SignResponse;
  patient: { id: string; fullName: string };
  onNew: () => void;
}) {
  const { medications } = result;
  return (
    <Card className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-display text-lg font-semibold tracking-tight">Signed into {patient.fullName}'s record</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {result.editedByClinician
              ? "You edited the AI draft before signing; the draft and the signed version are both in the audit log."
              : "Signed as drafted by the AI; recorded in the audit log."}
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <Outcome label="Diagnoses added" items={result.addedDiagnoses} emptyText="None new — existing diagnoses kept." />
        <Outcome label="Medications started" items={medications.started} emptyText="None" />
        <Outcome label="Medications adjusted" items={medications.adjusted} emptyText="None" />
        <Outcome label="Medications stopped" items={medications.stopped} emptyText="None" />
      </dl>
      {medications.continued.length ? (
        <p className="text-xs text-muted-foreground">Continued unchanged: {medications.continued.join(", ")}</p>
      ) : null}
      {result.appointmentId ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarCheck className="h-3.5 w-3.5" /> Linked appointment marked completed.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button asChild>
          <Link href={`/dashboard/patients/${patient.id}`}>Open patient record</Link>
        </Button>
        <Button type="button" variant="outline" onClick={onNew}>
          New consultation
        </Button>
      </div>
    </Card>
  );
}

function Outcome({ label, items, emptyText }: { label: string; items: string[]; emptyText: string }) {
  return (
    <div>
      <dt className="data-label mb-1">{label}</dt>
      <dd>
        {items.length ? (
          <ul className="flex flex-wrap gap-1">
            {items.map((item, i) => (
              <li key={`${i}-${item}`}>
                <Chip text={item} />
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">{emptyText}</span>
        )}
      </dd>
    </div>
  );
}

/** Read-only rendering of an extraction (signed and discarded consultations, drafts awaiting a clinician). */
export function ExtractionChips({ extraction }: { extraction: ClinicalExtraction }) {
  const sections: { label: string; items: string[] }[] = [
    ...LIST_SECTIONS.map((s) => ({ label: s.label, items: extraction[s.key] })),
    {
      label: "Medications",
      items: extraction.medications.map((m) => [m.name, m.dosage, m.frequency].filter(Boolean).join(" · ")),
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {sections.map((section) => (
        <div key={section.label}>
          <p className="data-label mb-1">{section.label}</p>
          {section.items.length ? (
            <ul className="flex flex-wrap gap-1">
              {section.items.map((item, i) => (
                <li key={`${i}-${item}`}>
                  <Chip text={item} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Edit counting ────────────────────────────────────────────────────────────

function setDelta(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let n = 0;
  for (const x of left) if (!right.has(x)) n++;
  for (const x of right) if (!left.has(x)) n++;
  return n;
}

/**
 * How far the reviewed version is from the AI draft: one per item added or
 * removed, one per medication added/removed or per dosage/frequency change,
 * one when the summary differs.
 */
function countEdits(
  draft: ClinicalExtraction,
  draftSummary: string,
  lists: Record<ListKey, string[]>,
  medications: MedicationRow[],
  summary: string,
): number {
  let n = 0;
  for (const section of LIST_SECTIONS) {
    n += setDelta(draft[section.key].map(normaliseClinicalTerm), lists[section.key].map(normaliseClinicalTerm));
  }
  const before = new Map(draft.medications.map((m) => [normaliseClinicalTerm(m.name), m]));
  const after = new Map(
    medications.filter((m) => m.name.trim()).map((m) => [normaliseClinicalTerm(m.name), m]),
  );
  for (const [key, a] of before) {
    const b = after.get(key);
    if (!b) {
      n++;
      continue;
    }
    if (normaliseClinicalTerm(a.dosage ?? "") !== normaliseClinicalTerm(b.dosage)) n++;
    if (normaliseClinicalTerm(a.frequency ?? "") !== normaliseClinicalTerm(b.frequency)) n++;
  }
  for (const key of after.keys()) if (!before.has(key)) n++;
  if (summary.trim() !== draftSummary.trim()) n++;
  return n;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
