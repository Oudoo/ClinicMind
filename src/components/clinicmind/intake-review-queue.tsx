"use client";

import { Fragment, useId, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Merge, UserPlus, UserRoundSearch, XCircle } from "lucide-react";
import type { IntakeStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { IntakeSubmissionDTO } from "@/modules/intake/service";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { PatientPicker, type PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { GENDER_LABELS, apiErrorMessage, type BadgeTone, type PatientGender } from "@/components/clinicmind/patient-shared";
import { treatmentLabel } from "@/components/clinicmind/intake-copy";

const STATUS_TONE: Record<IntakeStatus, BadgeTone> = { PENDING: "warning", ACCEPTED: "success", REJECTED: "danger" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `1994-06-17` → `17 Jun 1994` (built by hand: no Intl, so server and browser render the same text). */
function dobLabel(key: string | undefined): string | null {
  const m = key ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : (key ?? null);
}

/** A phone number kept left-to-right inside Arabic text (otherwise the "+" jumps to the end). */
function Phone({ value }: { value: string | null | undefined }) {
  return value ? (
    <bdi dir="ltr" className="font-mono text-xs">
      {value}
    </bdi>
  ) : null;
}

/** Patient-typed entries, each isolated so Arabic and English items keep their own direction. */
function list(items: readonly string[]): ReactNode {
  if (!items.length) return null;
  return items.map((item, i) => (
    <Fragment key={`${i}-${item}`}>
      {i ? ", " : ""}
      <bdi>{item}</bdi>
    </Fragment>
  ));
}

/** Pieces joined with " · ", empty ones dropped. */
function joined(parts: readonly ReactNode[]): ReactNode {
  const present = parts.filter((p) => p !== null && p !== undefined && p !== "" && p !== false);
  if (!present.length) return null;
  return present.map((part, i) => (
    <Fragment key={i}>
      {i ? " · " : ""}
      {part}
    </Fragment>
  ));
}

export type QueueStatus = IntakeStatus | "all";

/**
 * The reception review queue: each submitted form with the phone-match
 * suggestion and the three decisions (accept as new, merge, reject).
 */
export function IntakeReviewQueue({
  submissions,
  status,
  counts,
  timezone,
  treatments,
}: {
  submissions: IntakeSubmissionDTO[];
  status: QueueStatus;
  counts: Record<IntakeStatus, number>;
  timezone: string;
  treatments: { key: string; name: string }[];
}) {
  const tabs: { key: QueueStatus; label: string; count: number | null }[] = [
    { key: "PENDING", label: "Pending", count: counts.PENDING },
    { key: "ACCEPTED", label: "Accepted", count: counts.ACCEPTED },
    { key: "REJECTED", label: "Rejected", count: counts.REJECTED },
    { key: "all", label: "All", count: null },
  ];
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-1.5" aria-label="Submission status">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/patients/intake?status=${t.key}`}
            aria-current={t.key === status ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
              t.key === status ? "border-accent bg-accent-muted text-accent" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t.label}
            {t.count !== null ? <span className="font-mono tabular-nums">{t.count}</span> : null}
          </Link>
        ))}
      </nav>

      {submissions.length ? (
        <div className="space-y-4">
          {submissions.map((s) => (
            <SubmissionCard key={s.id} submission={s} timezone={timezone} treatments={treatments} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            title={status === "PENDING" ? "Nothing to review" : "No forms here"}
            hint={status === "PENDING" ? "New onboarding forms appear here the moment a patient sends them." : "Change the status filter above."}
          />
        </Card>
      )}
    </div>
  );
}

function SubmissionCard({ submission: s, timezone, treatments }: { submission: IntakeSubmissionDTO; timezone: string; treatments: { key: string; name: string }[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [merging, setMerging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = s.data;
  const when = new Date(s.submittedAt);
  const treatmentName = (key: string) => {
    const t = treatments.find((x) => x.key === key);
    return t ? treatmentLabel(t.key, t.name, "en") : key;
  };

  async function accept(mode: "create" | "merge", patientId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ patientId: string; created: boolean }>(`/api/intake/submissions/${s.id}/accept`, {
        method: "POST",
        body: { mode, patientId },
      });
      toast({
        title: res.created ? "Patient created from the form" : "Form merged into the patient record",
        description: s.fullName,
        tone: "success",
      });
      setConfirmCreate(false);
      setMerging(false);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not accept the form", description: apiErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 dir="auto" className="font-display text-lg font-semibold tracking-tight">
              {s.fullName}
            </h3>
            <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
            <Badge tone="accent">{s.language === "ar" ? "Arabic" : "English"}</Badge>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {s.phone ?? "—"}
            {s.email ? ` · ${s.email}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            Sent {formatDateInTz(when, timezone)} at {formatTimeInTz(when, timezone)} · via{" "}
            {s.link.kind === "PATIENT" ? "personal link" : `open link${s.link.label ? ` “${s.link.label}”` : ""}`}
          </p>
        </div>

        {s.status === "PENDING" ? (
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Button type="button" size="sm" onClick={() => setConfirmCreate(true)} disabled={busy}>
              <UserPlus className="h-4 w-4" />
              Accept as new
            </Button>
            {s.matchedPatient ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void accept("merge", s.matchedPatient!.id)} disabled={busy}>
                <Merge className="h-4 w-4" />
                Merge into {s.matchedPatient.fullName}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => setMerging(true)} disabled={busy}>
              <UserRoundSearch className="h-4 w-4" />
              {s.matchedPatient ? "Merge into another…" : "Merge into…"}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="text-danger hover:bg-danger/10" onClick={() => setRejecting(true)} disabled={busy}>
              <XCircle className="h-4 w-4" />
              Reject
            </Button>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground md:text-right">
            {s.status === "ACCEPTED" && s.patient ? (
              <Link href={`/dashboard/patients/${s.patient.id}`} className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline">
                <CheckCircle2 className="h-4 w-4" />
                Open {s.patient.fullName}
              </Link>
            ) : null}
            {s.status === "REJECTED" && s.reviewNote ? <p className="max-w-xs">Rejected: {s.reviewNote}</p> : null}
            {s.reviewedBy ? (
              <p>
                by {s.reviewedBy.fullName}
                {s.reviewedAt ? ` · ${formatDateInTz(new Date(s.reviewedAt), timezone)}` : ""}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {s.status === "PENDING" && s.matchedPatient ? (
        <Alert tone="info" className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Looks like{" "}
            <Link href={`/dashboard/patients/${s.matchedPatient.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
              {s.matchedPatient.fullName}
            </Link>
            {s.matchedPatient.phone ? <span className="font-mono"> · {s.matchedPatient.phone}</span> : null} — same phone number as an existing patient.
          </span>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Section title="Personal">
          <Row label="Gender" value={GENDER_LABELS[d.gender as PatientGender] ?? d.gender} />
          <Row label="Date of birth" value={dobLabel(d.dateOfBirth)} />
          <Row label="WhatsApp" value={d.whatsappSame ? joined([<Phone key="p" value={d.phone} />, "same as mobile"]) : <Phone value={d.whatsapp} />} />
          <Row label="City" value={d.city} />
          <Row label="National ID" value={d.nationalId} mono />
        </Section>
        <Section title="Contact">
          <Row label="E-mail" value={d.email} />
          <Row label="Address" value={d.address} />
          <Row
            label="Emergency contact"
            value={joined([
              d.emergencyContactName ? <bdi key="n">{d.emergencyContactName}</bdi> : null,
              d.emergencyContactPhone ? <Phone key="p" value={d.emergencyContactPhone} /> : null,
              d.emergencyContactRelation ? <bdi key="r">({d.emergencyContactRelation})</bdi> : null,
            ])}
          />
        </Section>
        <Section title="Visit">
          <Row label="Interested in" value={list(d.treatmentKeys.map(treatmentName))} />
          <Row label="Concern" value={d.concern} />
          <Row label="Since" value={d.sinceWhen} />
        </Section>
        <Section title="Medical history">
          <Row label="Chronic conditions" value={list(d.chronicConditions)} />
          <Row label="Allergies" value={list(d.allergies)} />
          <Row label="Medications" value={list(d.medications.map((m) => (m.dose ? `${m.name} (${m.dose})` : m.name)))} />
          <Row label="Surgeries" value={list(d.surgeries)} />
          <Row label="WhatsApp updates" value={d.whatsappUpdates ? "Agreed" : "Not agreed"} />
        </Section>
      </div>

      <ConfirmDialog
        open={confirmCreate}
        onOpenChange={setConfirmCreate}
        title="Create a new patient from this form?"
        description={`${s.fullName} will be registered with the contact details, medical history and medications from the form.${s.matchedPatient ? ` An existing patient has the same phone (${s.matchedPatient.fullName}) — consider merging instead.` : ""}`}
        confirmLabel="Create patient"
        busy={busy}
        onConfirm={() => accept("create")}
      />
      {merging ? <MergeDialog name={s.fullName} busy={busy} onClose={() => setMerging(false)} onMerge={(p) => accept("merge", p.id)} /> : null}
      {rejecting ? <RejectDialog submissionId={s.id} name={s.fullName} onClose={() => setRejecting(false)} /> : null}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="data-label mb-2">{title}</p>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

/**
 * One answer. `dir="auto"` lays each value out in its own direction (an
 * Arabic concern keeps its punctuation at the right end, an English one at
 * the left); composite values isolate their pieces with <bdi>.
 */
function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  const empty = value === null || value === undefined || value === "" || value === false;
  return (
    <div className="flex flex-col gap-0.5 text-sm sm:flex-row sm:justify-between sm:gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd dir="auto" className={cn("min-w-0 break-words sm:text-right", mono && "font-mono text-xs", empty && "text-muted-foreground")}>
        {empty ? "—" : value}
      </dd>
    </div>
  );
}

function MergeDialog({ name, busy, onClose, onMerge }: { name: string; busy: boolean; onClose: () => void; onMerge: (patient: PatientOption) => void }) {
  const [patient, setPatient] = useState<PatientOption | null>(null);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent title={`Merge ${name}'s form into…`} description="Empty fields of the chosen patient are filled from the form; history and medications are appended without duplicates.">
        <div className="space-y-4">
          <PatientPicker value={patient} onChange={setPatient} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" onClick={() => patient && onMerge(patient)} disabled={busy || !patient}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Merge className="h-4 w-4" />}
              Merge
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ submissionId, name, onClose }: { submissionId: string; name: string; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/intake/submissions/${submissionId}/reject`, { method: "POST", body: { note: note.trim() } });
      toast({ title: "Form rejected", description: name, tone: "success" });
      router.refresh();
      onClose();
    } catch (err) {
      setError(fieldErrors(err).note ?? apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent title={`Reject ${name}'s form`} description="The form is kept for the record; nothing is written to any patient.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Reason" htmlFor={`${id}-note`} hint="Required · e.g. duplicate, test entry, wrong clinic">
            <DictationField onDictated={setNote} disabled={busy}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} required />
            </DictationField>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={busy || !note.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              Reject form
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
