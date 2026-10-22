"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, Loader2, Mic, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Select, Textarea } from "@/components/ui/input";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import { formatDate, formatTime } from "@/lib/utils";
import { isExtractionEmpty } from "@/modules/consultations/normalise";
import {
  TRANSCRIPT_MAX_LENGTH,
  TRANSCRIPT_MIN_LENGTH,
  type AppointmentOption,
  type ConsultationDetail,
  type ExtractResponse,
  type PatientOption,
} from "@/modules/consultations/types";
import { PatientPicker } from "./consultation-patient-picker";
import { ConsultationReview, DiscardButton, ExtractionChips } from "./consultation-review";
import { STATUS_LABEL, STATUS_TONE } from "./consultation-list";

export interface ConsultationPanelProps {
  /** The consultation opened from the list, or null for a new capture. */
  consultation: ConsultationDetail | null;
  /** Patient preselected for a new capture (e.g. arriving from the patient record). */
  presetPatient: PatientOption | null;
  canSign: boolean;
  userId: string | null;
  /** The list should refresh (a draft was created, signed or discarded). */
  onChanged: () => void;
  /** The open draft is gone: go back to a new capture. */
  onClosed: () => void;
  onNew: () => void;
  /** Open an existing consultation in the panel. */
  onOpen: (id: string) => void;
}

/**
 * Consultation Intelligence panel.
 *
 * Flow: paste transcript -> AI extracts a structured draft -> clinician
 * REVIEWS (every section editable) -> explicitly signs. Clinical decisions are
 * never auto-saved. Audio capture ships in a later release and is shown as
 * exactly that — never as a working button.
 */
export function ConsultationPanel(props: ConsultationPanelProps) {
  const { consultation, canSign, userId, onChanged, onClosed, onNew } = props;

  if (consultation) {
    if (consultation.status === "PENDING_REVIEW" && canSign) {
      return (
        <ConsultationReview
          consultationId={consultation.id}
          patient={consultation.patient}
          draft={consultation.extraction}
          draftSummary={consultation.summary ?? ""}
          appointment={null}
          empty={isExtractionEmpty(consultation.extraction)}
          canDiscard
          onSigned={onChanged}
          onClosed={onClosed}
          onNew={onNew}
        />
      );
    }
    const isAuthor = Boolean(userId) && consultation.doctor?.id === userId;
    return (
      <ConsultationReadOnly
        consultation={consultation}
        canDiscard={consultation.status === "PENDING_REVIEW" && isAuthor}
        onClosed={onClosed}
      />
    );
  }

  return <CaptureForm {...props} />;
}

// ── Capture ──────────────────────────────────────────────────────────────────

function CaptureForm({ presetPatient, canSign, onChanged, onClosed, onNew, onOpen }: ConsultationPanelProps) {
  const { toast } = useToast();
  const [patient, setPatient] = useState<PatientOption | null>(presetPatient);
  const [appointment, setAppointment] = useState<AppointmentOption | null>(null);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<{
    result: ExtractResponse;
    patient: PatientOption;
    appointment: AppointmentOption | null;
  } | null>(null);

  const length = transcript.trim().length;
  const canExtract = Boolean(patient) && length >= TRANSCRIPT_MIN_LENGTH && length <= TRANSCRIPT_MAX_LENGTH && !busy;

  async function extract() {
    if (!patient || !canExtract) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<ExtractResponse>("/api/consultations/extract", {
        method: "POST",
        body: { patientId: patient.id, transcript: transcript.trim(), appointmentId: appointment?.id },
      });
      onChanged();
      if (!canSign) {
        toast({
          title: "Draft saved for clinician review",
          description: result.empty ? "No structured data could be extracted from the transcript." : undefined,
          tone: "info",
        });
        onOpen(result.consultationId);
        return;
      }
      if (result.empty) {
        toast({
          title: "No structured data could be extracted",
          description: "The review starts blank — enter the findings before signing.",
          tone: "info",
        });
      }
      setExtracted({ result, patient, appointment });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        const errors = fieldErrors(err);
        setError(errors.transcript ?? errors.patientId ?? errors.appointmentId ?? err.message);
      } else if (err instanceof ApiError && err.status === 404) {
        setError("The patient or the appointment could not be found. Pick them again.");
      } else {
        setError(err instanceof Error ? err.message : "Extraction failed. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (extracted) {
    return (
      <ConsultationReview
        consultationId={extracted.result.consultationId}
        patient={extracted.patient}
        draft={extracted.result.extraction}
        draftSummary={extracted.result.summary}
        appointment={extracted.appointment}
        empty={extracted.result.empty}
        canDiscard
        onSigned={onChanged}
        onClosed={onClosed}
        onNew={onNew}
      />
    );
  }

  return (
    <Card className="space-y-5">
      <SectionTitle
        title="New consultation"
        description="Pick the patient, paste the transcript and extract a structured draft. Nothing reaches the record until a clinician signs."
      />

      <PatientPicker
        value={patient}
        onChange={(next) => {
          setPatient(next);
          setAppointment(null);
        }}
        disabled={busy}
      />

      {patient ? (
        <AppointmentSelect key={patient.id} patientId={patient.id} value={appointment} onChange={setAppointment} disabled={busy} />
      ) : null}

      <Field
        label="Transcript"
        htmlFor="consultation-transcript"
        hint={
          <span className="flex justify-between gap-4">
            <span>At least {TRANSCRIPT_MIN_LENGTH} characters.</span>
            <span className="font-mono tabular-nums">
              {transcript.length.toLocaleString()} / {TRANSCRIPT_MAX_LENGTH.toLocaleString()}
            </span>
          </span>
        }
      >
        <Textarea
          id="consultation-transcript"
          rows={12}
          maxLength={TRANSCRIPT_MAX_LENGTH}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder="Paste the consultation transcript…"
          disabled={busy}
        />
      </Field>

      {error ? <Alert>{error}</Alert> : null}

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span title="Audio capture ships in the next release" className="inline-flex">
          <Button type="button" variant="outline" disabled aria-disabled="true">
            <Mic />
            Audio capture — next release
          </Button>
        </span>
        <Button type="button" onClick={extract} disabled={!canExtract}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {busy ? "Extracting…" : "Extract clinical data"}
        </Button>
      </div>
    </Card>
  );
}

function AppointmentSelect({
  patientId,
  value,
  onChange,
  disabled,
}: {
  patientId: string;
  value: AppointmentOption | null;
  onChange: (appointment: AppointmentOption | null) => void;
  disabled: boolean;
}) {
  const [appointments, setAppointments] = useState<AppointmentOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 30);
    apiFetch<{ appointments: AppointmentOption[] }>(
      `/api/appointments?patientId=${encodeURIComponent(patientId)}&from=${from.toISOString()}&to=${to.toISOString()}`,
    )
      .then((data) => {
        if (cancelled) return;
        setAppointments(
          data.appointments.filter(
            (a) => a.patientId === patientId && a.status !== "CANCELLED" && a.status !== "NO_SHOW",
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const hint = failed
    ? "Appointments could not be loaded; you can still sign without a link."
    : appointments === null
      ? "Loading today's and upcoming appointments…"
      : appointments.length
        ? "The linked appointment is marked completed when the consultation is signed."
        : "No upcoming appointments for this patient in the next 30 days.";

  return (
    <Field label="Appointment (optional)" htmlFor="consultation-appointment" hint={hint}>
      <div className="relative">
        <Select
          id="consultation-appointment"
          value={value?.id ?? ""}
          onChange={(e) => onChange(appointments?.find((a) => a.id === e.target.value) ?? null)}
          disabled={disabled || !appointments?.length}
        >
          <option value="">No linked appointment</option>
          {(appointments ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {formatDate(a.startsAt)} {formatTime(a.startsAt)} — {a.reason ?? "Appointment"} ({a.status.toLowerCase()})
            </option>
          ))}
        </Select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
    </Field>
  );
}

// ── Read-only ────────────────────────────────────────────────────────────────

function ConsultationReadOnly({
  consultation,
  canDiscard,
  onClosed,
}: {
  consultation: ConsultationDetail;
  canDiscard: boolean;
  onClosed: () => void;
}) {
  const { patient, status } = consultation;
  const capturedBy = consultation.doctor?.fullName ?? "unknown";
  return (
    <Card className="space-y-5">
      <SectionTitle
        title={status === "SIGNED" ? "Signed consultation" : status === "DISCARDED" ? "Discarded draft" : "Draft awaiting review"}
        description={`${patient.fullName} · captured ${formatDate(consultation.createdAt)} ${formatTime(consultation.createdAt)} by ${capturedBy}`}
        action={<Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>}
      />

      {status === "PENDING_REVIEW" ? (
        <Alert tone="info">
          Awaiting clinician review. Only a doctor or the clinic owner can sign this draft into the patient's record.
        </Alert>
      ) : null}
      {status === "SIGNED" && consultation.reviewedAt ? (
        <p className="text-sm text-muted-foreground">
          Signed {formatDate(consultation.reviewedAt)} {formatTime(consultation.reviewedAt)}
          {consultation.reviewedBy?.fullName ? ` by ${consultation.reviewedBy.fullName}` : ""}.
        </p>
      ) : null}
      {status === "DISCARDED" ? (
        <p className="text-sm text-muted-foreground">Nothing from this draft was written to the patient's record.</p>
      ) : null}

      <ExtractionChips extraction={consultation.extraction} />

      <div>
        <p className="data-label mb-1">Visit summary</p>
        <p className="whitespace-pre-wrap text-sm">{consultation.summary || <span className="text-muted-foreground">—</span>}</p>
      </div>

      {consultation.transcript ? (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Transcript</summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-sans text-sm">
            {consultation.transcript}
          </pre>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button asChild variant="outline">
          <Link href={`/dashboard/patients/${patient.id}`}>Open patient record</Link>
        </Button>
        {canDiscard ? <DiscardButton consultationId={consultation.id} onDone={onClosed} /> : null}
      </div>
    </Card>
  );
}
