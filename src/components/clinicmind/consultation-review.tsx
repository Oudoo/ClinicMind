"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { CalendarCheck, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2, Unlink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import { cn, formatDate, formatTime } from "@/lib/utils";
import { medicationKey, normaliseClinicalTerm } from "@/modules/consultations/normalise";
import { findSummaryMentions, rebuildSummary } from "@/modules/consultations/summary";
import {
  EXTRACTION_LIMITS,
  SUMMARY_MAX_LENGTH,
  type ActiveMedication,
  type AppointmentOption,
  type ClinicalExtraction,
  type SafetyConflictBody,
  type SafetyFinding,
  type SignResponse,
} from "@/modules/consultations/types";
import {
  SafetyPanel,
  overridesFor,
  stopsResolved,
  useSafetyCheck,
  warningSignature,
} from "./consultation-safety";
import { SummaryCheck, mentionSignature } from "./consultation-summary-check";

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
 *
 * The prescription is checked live against the patient's record (allergies,
 * interactions, duplicates, pregnancy, age, dose, conditions): every stop
 * needs a typed reason and warnings an acknowledgement before the Sign button
 * unlocks, and the summary may not mention items removed from the draft
 * unless rewritten or confirmed. The server repeats every check on signing.
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
  /** When the clinician asked to sign: decides whether the linked appointment can be completed (not before its start). */
  const [signRequestedAt, setSignRequestedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [signed, setSigned] = useState<SignResponse | null>(null);
  /** Override reasons by finding key ("rule|medication"). */
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** The warnings the clinician acknowledged (their signature), so new warnings need a new tick. */
  const [acknowledgedSignature, setAcknowledgedSignature] = useState<string | null>(null);
  /** The summary mismatch the clinician confirmed (its signature). */
  const [confirmedMentions, setConfirmedMentions] = useState<string | null>(null);
  /** Findings the server returned with a 409: they win over the live preview for the same prescription. */
  const [serverSafety, setServerSafety] = useState<{ request: string; findings: SafetyFinding[]; notice: string } | null>(null);
  const safetyRef = useRef<HTMLDivElement>(null);

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
  const prescribedKeys = useMemo(
    () => new Set(medications.filter((m) => m.name.trim()).map((m) => medicationKey(m))),
    [medications],
  );
  const blankMedicationRows = medications.filter((m) => !m.name.trim()).length;
  const nothingEntered = LIST_SECTIONS.every((s) => lists[s.key].length === 0) && medications.length === 0;

  const extraction = useMemo(() => toExtraction(lists, medications), [lists, medications]);
  const safetyRequest = useMemo(
    () => ({ medications: extraction.medications, diagnoses: extraction.diagnoses, stopMedicationIds: [...stopIds].sort() }),
    [extraction, stopIds],
  );
  const requestKey = JSON.stringify(safetyRequest);
  const live = useSafetyCheck(consultationId, safetyRequest);
  const fromServer = serverSafety && serverSafety.request === requestKey ? serverSafety : null;
  const findings = fromServer ? fromServer.findings : live.findings;
  const warningsKey = warningSignature(findings);
  const warningsAcknowledged = warningsKey !== "" && acknowledgedSignature === warningsKey;
  const stopCount = findings.filter((f) => f.severity === "stop").length;
  const warningCount = findings.filter((f) => f.severity === "warn").length;
  const safetyReady = !live.pending && stopsResolved(findings, reasons) && (warningCount === 0 || warningsAcknowledged);

  const trimmedSummary = summary.trim();
  const mentions = useMemo(
    () => findSummaryMentions({ draft, signed: extraction, summary: trimmedSummary }),
    [draft, extraction, trimmedSummary],
  );
  const mentionsKey = mentionSignature(mentions);
  const summaryConfirmed = mentions.length > 0 && confirmedMentions === mentionsKey;
  const summaryReady = mentions.length === 0 || summaryConfirmed;

  const blockers = [
    live.pending ? "the safety checks are still running" : null,
    stopsResolved(findings, reasons) ? null : "give a reason for every stop",
    warningCount && !warningsAcknowledged ? "confirm you reviewed the warnings" : null,
    summaryReady ? null : "rewrite the summary or confirm it is correct",
  ].filter((b): b is string => Boolean(b));

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

  function rewriteSummary() {
    setSummary(rebuildSummary(extraction, { reason: appointment?.reason }).slice(0, SUMMARY_MAX_LENGTH));
  }

  async function sign() {
    setBusy(true);
    setFormError(null);
    try {
      const result = await apiFetch<SignResponse>(`/api/consultations/${consultationId}/sign`, {
        method: "POST",
        body: {
          summary: trimmedSummary,
          extraction,
          appointmentId: appointment?.id,
          stopMedicationIds: [...stopIds],
          overrides: overridesFor(findings, reasons),
          acknowledgedWarnings: warningCount > 0 && warningsAcknowledged,
          summaryConfirmed,
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
      } else if (err instanceof ApiError && err.status === 409 && (err.code === "safety_stop" || err.code === "safety_warning")) {
        // The server's findings win over the live preview.
        const body = err.body as Partial<SafetyConflictBody> | null;
        setServerSafety({
          request: requestKey,
          findings: Array.isArray(body?.findings) ? body.findings : findings,
          notice:
            err.code === "safety_stop"
              ? "Signing was refused: give a reason for every stop below, or change the prescription."
              : "Signing was refused: review the warnings below and tick “I have reviewed these warnings”.",
        });
        safetyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else if (err instanceof ApiError && err.status === 409 && err.code === "summary_mismatch") {
        setFormError("The summary still mentions items you removed from the draft: rewrite it from the signed items or confirm it is correct.");
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
    appointment
      ? signRequestedAt !== null && new Date(appointment.startsAt).getTime() > signRequestedAt
        ? "linked to an appointment that has not started yet, which stays as it is."
        : "with the linked appointment marked completed."
      : "",
    stopCount ? `${stopCount} safety ${plural(stopCount, "stop is", "stops are")} overridden with your reason${plural(stopCount, "", "s")}.` : "",
    warningCount ? `${warningCount} ${plural(warningCount, "warning", "warnings")} acknowledged.` : "",
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
              <span className="block text-xs text-muted-foreground">
                Marked completed when you sign, once its start time has passed.
              </span>
            </span>
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAppointment(null)}>
            <Unlink />
            Unlink
          </Button>
        </div>
      ) : null}

      {/* One column while the review shares the screen with the list (lg), two when there is room. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
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
          prescribedKeys={prescribedKeys}
          onToggle={toggleStop}
        />
        <p className="text-xs text-muted-foreground">
          Ticked medications are stopped when you sign. A current medication that also appears in the
          prescription above (same medicine, even under another name or strength) is updated in place —
          unless it is ticked, in which case the current entry is stopped and a fresh one started.
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

      <SummaryCheck
        summary={trimmedSummary}
        mentions={mentions}
        confirmed={summaryConfirmed}
        onConfirmedChange={(value) => setConfirmedMentions(value ? mentionsKey : null)}
        onRewrite={rewriteSummary}
        disabled={busy}
      />

      {blankMedicationRows ? (
        <Alert>
          Every medication needs a name — fill in or remove the{" "}
          {blankMedicationRows === 1 ? "empty row" : `${blankMedicationRows} empty rows`}.
        </Alert>
      ) : null}
      <div ref={safetyRef} className="scroll-mt-4">
        <SafetyPanel
          findings={findings}
          context={live.context}
          pending={live.pending && !fromServer}
          error={live.error}
          hasMedications={extraction.medications.length > 0}
          reasons={reasons}
          onReasonChange={(key, reason) => setReasons((prev) => ({ ...prev, [key]: reason }))}
          acknowledged={warningsAcknowledged}
          onAcknowledgedChange={(value) => setAcknowledgedSignature(value ? warningsKey : null)}
          serverNotice={fromServer?.notice ?? null}
          disabled={busy}
        />
      </div>

      {formError ? <Alert>{formError}</Alert> : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        {canDiscard ? <DiscardButton consultationId={consultationId} disabled={busy} onDone={onClosed} /> : <span />}
        <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <Button
            type="button"
            onClick={() => {
              setSignRequestedAt(Date.now());
              setSignOpen(true);
            }}
            disabled={busy || blankMedicationRows > 0 || !safetyReady || !summaryReady}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Review complete — sign
          </Button>
          {blockers.length && !busy ? (
            <p className="text-xs text-muted-foreground sm:text-right" data-testid="sign-blockers">
              To sign: {blockers.join("; ")}.
            </p>
          ) : null}
        </div>
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
              <li key={item} className="max-w-full">
                <Chip text={item} onRemove={() => onChange(items.filter((x) => x !== item))} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-2 px-1 text-xs text-muted-foreground">None.</p>
        )}
        {/* Full-width rows on phones; the input takes the room it needs beside the button elsewhere. */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={id}
            value={draft}
            placeholder={placeholder}
            maxLength={EXTRACTION_LIMITS.itemLength}
            disabled={full}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-9 min-w-0 sm:min-w-[10rem] sm:flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-full sm:w-auto sm:shrink-0"
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
    <span className="inline-flex max-w-full items-start gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs font-medium text-accent">
      <span className="min-w-0 break-words">{text}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${text}`}
          className="shrink-0 rounded p-0.5 hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div className={cn("hidden gap-2 px-1 sm:grid lg:hidden xl:grid", MEDICATION_COLUMNS)} aria-hidden="true">
          <span className="data-label">Name</span>
          <span className="data-label">Dosage</span>
          <span className="data-label">Frequency</span>
          <span />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No medications in this consultation.</p>
      )}
      {rows.map((row) => (
        <div key={row.key} className={MEDICATION_ROW}>
          <Input
            aria-label="Medication name"
            placeholder="Name, e.g. Doxycycline 100 mg"
            value={row.name}
            maxLength={EXTRACTION_LIMITS.medicationName}
            onChange={(e) => update(row.key, { name: e.target.value })}
            className="h-9 min-w-0 lg:col-span-3 xl:col-span-1"
          />
          <Input
            aria-label="Dosage"
            placeholder="Dosage, e.g. 500 mg"
            value={row.dosage}
            maxLength={EXTRACTION_LIMITS.medicationField}
            onChange={(e) => update(row.key, { dosage: e.target.value })}
            className="h-9 min-w-0"
          />
          <Input
            aria-label="Frequency"
            placeholder="Frequency, e.g. twice daily"
            value={row.frequency}
            maxLength={EXTRACTION_LIMITS.medicationField}
            onChange={(e) => update(row.key, { frequency: e.target.value })}
            className="h-9 min-w-0"
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
  prescribedKeys,
  onToggle,
}: {
  medications: ActiveMedication[] | null;
  error: string | null;
  selected: ReadonlySet<string>;
  prescribedKeys: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (error) return <Alert tone="info">{error}</Alert>;
  if (medications === null) return <p className="text-xs text-muted-foreground">Loading current medications…</p>;
  if (!medications.length) return <p className="text-xs text-muted-foreground">No active medications on record.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {medications.map((m) => {
        const checked = selected.has(m.id);
        const inPrescription = prescribedKeys.has(medicationKey(m));
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
      {result.safety?.overrides ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldAlert className="h-3.5 w-3.5 text-warning" />
          {result.safety.overrides} prescribing-safety {plural(result.safety.overrides, "override", "overrides")} recorded with your
          {plural(result.safety.overrides, " reason", " reasons")} for the clinic owner's review.
        </p>
      ) : null}
      {result.appointment ? (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="signed-appointment">
          <CalendarCheck className="mt-px h-3.5 w-3.5 shrink-0" />
          {result.appointment.completed
            ? "Linked appointment marked completed."
            : `Linked appointment left as ${result.appointment.status.toLowerCase().replace(/_/g, " ")}${result.appointment.reason ? `: ${result.appointment.reason}` : "."}`}
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

/** The reviewed extraction as it will be signed (blank medication rows left out). */
function toExtraction(lists: Record<ListKey, string[]>, medications: MedicationRow[]): ClinicalExtraction {
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

/**
 * Medication rows: stacked on phones; name · dosage · frequency · remove in a
 * row when the review has the width (sm, xl); at lg the review shares the
 * screen with the list, so the name gets its own line above dosage and frequency.
 */
const MEDICATION_COLUMNS = "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem]";
const MEDICATION_ROW =
  "grid grid-cols-1 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem] sm:border-0 sm:p-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] lg:border lg:p-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_2.25rem] xl:border-0 xl:p-0";

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
