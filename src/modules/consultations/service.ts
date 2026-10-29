import { z } from "zod";
import { NextResponse } from "next/server";
import type { AppointmentStatus, Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ingestInBackground } from "@/modules/knowledge/ingest";
import { handleApiError } from "@/lib/api";
import { requireTenantPatient } from "@/lib/tenant-scope";
import {
  ClinicalExtractionSchema,
  MAX_EXTRACTION_ITEM_LENGTH,
  MAX_EXTRACTION_ITEMS,
  MAX_MEDICATION_NAME_LENGTH,
  MedicationSchema,
  normaliseClinicalTerm,
  normaliseExtraction,
  type ClinicalExtraction,
} from "@/lib/ai/extraction";
import { notify } from "@/modules/notifications/service";
import { getTenantTimezone } from "@/modules/appointments/service";
import { transitionTimeBlock } from "@/modules/appointments/rules";
import { recallsOnConsultationSigned, safely } from "@/modules/recalls/engine";
import { medicationKey } from "./normalise";
import { findSummaryMentions } from "./summary";
import { loadSafetyRecord, resolveOverrides, runSafetyChecks } from "./safety/context";
import {
  CONSULTATION_STATUSES,
  SAFETY_REASON_MAX_LENGTH,
  SAFETY_REASON_MIN_LENGTH,
  SUMMARY_MAX_LENGTH,
  type ActiveMedication,
  type ConsultationDetail,
  type ConsultationListItem,
  type ConsultationListResponse,
  type ConsultationPerson,
  type ConsultationStatus,
  type SafetyCheckResponse,
  type SignResponse,
} from "./types";

/**
 * Consultation Intelligence domain service: review-before-sign.
 *
 * A consultation is captured (transcript + AI draft) as PENDING_REVIEW and
 * nothing reaches the patient's clinical record until a clinician signs it.
 * Signing is one transaction that creates the immutable Visit, appends only
 * new diagnoses, reconciles medications against the patient's active list (by
 * generic, so a renamed or re-strengthened line updates the existing entry)
 * and emits timeline events; the audit row records the AI draft next to what
 * was actually signed so reviewers can see what the clinician changed.
 *
 * Before anything is written, the prescribing-safety checks (./safety) are
 * recomputed from the patient's record: a "stop" needs the clinician's typed
 * reason and warnings an acknowledgement, each stored as a SafetyOverride in
 * the same transaction; and the summary may not mention a diagnosis or
 * medication removed from the draft unless the clinician confirms it.
 */

export const STOP_REASON_ON_SIGN = "Stopped at consultation sign";

const TERMINAL_APPOINTMENT_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

/**
 * Domain failure with its HTTP mapping; `entity` names what was not found and
 * `payload` carries what the client needs to resolve a conflict (the safety
 * findings, the summary mentions).
 */
export class ConsultationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly entity?: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(entity ? `${code} (${entity})` : code);
    this.name = "ConsultationError";
  }
}

/** Route-handler error mapping: domain errors first, then the shared mapping. */
export function handleConsultationError(err: unknown): NextResponse {
  if (err instanceof ConsultationError) {
    return NextResponse.json(
      { error: err.code, ...(err.entity ? { entity: err.entity } : {}), ...(err.payload ?? {}) },
      { status: err.status },
    );
  }
  if (err instanceof SyntaxError) {
    // `req.json()` on a body that is not JSON.
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return handleApiError(err);
}

export interface Actor {
  userId: string | null;
  email: string | null;
  ip?: string | null;
}

const zId = z.string().trim().min(1).max(64);

/** "I am prescribing this anyway, because…" for one stop (or, optionally, a warning). */
export const SafetyOverrideSchema = z.object({
  rule: z.string().trim().min(1).max(80),
  medication: z.string().trim().min(1).max(MAX_MEDICATION_NAME_LENGTH),
  reason: z.string().trim().min(SAFETY_REASON_MIN_LENGTH).max(SAFETY_REASON_MAX_LENGTH),
});

export const SignInput = z.object({
  summary: z.string().trim().max(SUMMARY_MAX_LENGTH).optional(),
  extraction: ClinicalExtractionSchema.optional(),
  appointmentId: zId.optional(),
  stopMedicationIds: z.array(zId).max(MAX_EXTRACTION_ITEMS).default([]),
  /** A reason for every prescribing-safety stop the clinician overrides. */
  overrides: z.array(SafetyOverrideSchema).max(200).default([]),
  /** The clinician reviewed the prescribing-safety warnings. */
  acknowledgedWarnings: z.boolean().default(false),
  /** The summary is correct even though it mentions items removed from the draft. */
  summaryConfirmed: z.boolean().default(false),
});
export type SignInput = z.infer<typeof SignInput>;

/** Body of POST /api/consultations/[id]/safety-check: the review panel's current prescription. */
export const SafetyCheckInput = z.object({
  medications: z.array(MedicationSchema).max(MAX_EXTRACTION_ITEMS).optional(),
  diagnoses: z.array(z.string().trim().min(1).max(MAX_EXTRACTION_ITEM_LENGTH)).max(MAX_EXTRACTION_ITEMS).optional(),
  stopMedicationIds: z.array(zId).max(MAX_EXTRACTION_ITEMS).default([]),
});
export type SafetyCheckInput = z.infer<typeof SafetyCheckInput>;

export const ListQuery = z.object({
  status: z.enum(CONSULTATION_STATUSES as [ConsultationStatus, ...ConsultationStatus[]]).optional(),
  patientId: zId.optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

// ── Signing ──────────────────────────────────────────────────────────────────

export async function signConsultation(
  tenantId: string,
  consultationId: string,
  input: SignInput,
  actor: Actor,
): Promise<SignResponse> {
  const consultation = await db.consultation.findFirst({ where: { id: consultationId, tenantId } });
  if (!consultation) throw new ConsultationError(404, "not_found", "consultation");
  if (consultation.status !== "PENDING_REVIEW") throw new ConsultationError(409, "not_pending_review");

  const draft = normaliseExtraction(consultation.extraction);
  const signed = input.extraction ?? draft;
  const draftSummary = consultation.summary ?? "";
  const summary = input.summary ?? draftSummary;
  const editedByClinician = !sameExtraction(draft, signed) || summary !== draftSummary;
  const stopIds = [...new Set(input.stopMedicationIds)];
  const now = new Date();
  // The clinic clock decides whether the linked appointment may be completed now.
  const timezone = await getTenantTimezone(tenantId);

  const result = await db.$transaction(async (tx) => {
    // Re-prove the patient belongs to this tenant inside the transaction
    // (SEC-4): everything below is appended to that patient's record.
    await requireTenantPatient(tenantId, consultation.patientId, tx);
    const patientId = consultation.patientId;

    // The linked appointment must be the tenant's AND this patient's; a foreign
    // or mismatched id is indistinguishable from a missing one.
    let appointment: { id: string; status: AppointmentStatus; startsAt: Date; endsAt: Date } | null = null;
    if (input.appointmentId) {
      const found = await tx.appointment.findFirst({
        where: { id: input.appointmentId, tenantId, patientId, ...notDeleted },
        select: { id: true, status: true, startsAt: true, endsAt: true, visit: { select: { id: true } } },
      });
      if (!found) throw new ConsultationError(404, "not_found", "appointment");
      if (found.visit) throw new ConsultationError(409, "appointment_already_signed");
      appointment = { id: found.id, status: found.status, startsAt: found.startsAt, endsAt: found.endsAt };
    }

    // Medications to stop must be this patient's, before anything is decided.
    const stopRows = stopIds.length
      ? await tx.medication.findMany({
          where: { id: { in: stopIds }, tenantId, patientId },
          select: { id: true, name: true, active: true },
        })
      : [];
    if (stopRows.length !== stopIds.length) throw new ConsultationError(404, "not_found", "medication");

    // Prescribing safety, recomputed from the record — the browser's findings
    // are only a preview. Every stop needs a reason, warnings an acknowledgement.
    const record = await loadSafetyRecord(tx, tenantId, patientId);
    const { findings } = runSafetyChecks(record, {
      proposed: signed.medications,
      diagnoses: signed.diagnoses,
      stopMedicationIds: stopIds,
      now,
    });
    const resolution = resolveOverrides(findings, input.overrides, input.acknowledgedWarnings);
    if (!resolution.ok) {
      throw new ConsultationError(409, resolution.error, undefined, { findings, missing: resolution.missing });
    }
    if (resolution.accepted.length && !actor.userId) throw new ConsultationError(403, "forbidden");

    // The signed summary must match what is signed (audit #02).
    const mentions = findSummaryMentions({ draft, signed, summary });
    if (mentions.length && !input.summaryConfirmed) {
      throw new ConsultationError(409, "summary_mismatch", undefined, { mentions });
    }

    const visit = await tx.visit.create({
      data: {
        tenantId,
        patientId,
        doctorId: actor.userId,
        appointmentId: appointment?.id ?? null,
        transcript: consultation.transcript,
        summary: summary || null,
        notes: summary || null,
      },
      select: { id: true },
    });

    // The linked appointment is completed with the signature — unless it is
    // already closed, or the appointment clock does not allow completing it yet
    // (signed before its start time): then it is linked but left as it is.
    let appointmentOutcome: SignResponse["appointment"] = null;
    if (appointment) {
      const { id, status } = appointment;
      if (TERMINAL_APPOINTMENT_STATUSES.has(status)) {
        const reason = status === "COMPLETED" ? null : `The appointment is ${status === "NO_SHOW" ? "a no-show" : "cancelled"}; its status was left as it is.`;
        appointmentOutcome = { id, status, completed: status === "COMPLETED", reason };
      } else {
        const block = transitionTimeBlock(appointment, "COMPLETED", now, timezone);
        if (block) {
          appointmentOutcome = { id, status, completed: false, reason: block.message };
        } else {
          await tx.appointment.update({ where: { id }, data: { status: "COMPLETED", statusChangedAt: now } });
          appointmentOutcome = { id, status: "COMPLETED", completed: true, reason: null };
        }
      }
    }

    await tx.consultation.update({
      where: { id: consultation.id },
      data: {
        status: "SIGNED",
        visitId: visit.id,
        extraction: toJson(signed),
        summary: summary || null,
        reviewedById: actor.userId,
        reviewedAt: now,
      },
    });

    // Diagnoses: append only what the history does not already hold
    // (case-insensitive, whitespace-normalised). Never overwrite.
    const history = await tx.medicalHistory.findUnique({ where: { patientId } });
    const existingDiagnoses = stringList(history?.diagnoses);
    const known = new Set(existingDiagnoses.map(normaliseClinicalTerm));
    const addedDiagnoses: string[] = [];
    for (const diagnosis of signed.diagnoses) {
      const key = normaliseClinicalTerm(diagnosis);
      if (known.has(key)) continue;
      known.add(key);
      addedDiagnoses.push(diagnosis);
    }
    if (addedDiagnoses.length) {
      await tx.medicalHistory.upsert({
        where: { patientId },
        create: { tenantId, patientId, diagnoses: addedDiagnoses },
        update: { diagnoses: [...existingDiagnoses, ...addedDiagnoses] },
      });
    }

    // Stops come first so a medication that is stopped and re-prescribed in
    // the same sign ends up as a fresh active row, not a stopped one.
    const stopped: string[] = [];
    for (const row of stopRows) {
      if (!row.active) continue; // already stopped: nothing to change
      await tx.medication.update({
        where: { id: row.id },
        data: { active: false, stoppedAt: now, stopReason: STOP_REASON_ON_SIGN },
      });
      stopped.push(row.name);
    }

    // Reconcile: an active medication with the same generic key ("Minoxidil
    // 5%" ≡ "Minoxidil 5% solution", "Roaccutane" ≡ "Isotretinoin") is
    // updated (dosage/frequency when stated, and the visit link) instead of
    // being duplicated; anything else is a new prescription of this visit.
    const active = await tx.medication.findMany({
      where: { tenantId, patientId, active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, dosage: true, frequency: true },
    });
    const byKey = new Map<string, (typeof active)[number]>();
    for (const m of active) if (!byKey.has(medicationKey(m))) byKey.set(medicationKey(m), m);
    const started: string[] = [];
    const adjusted: string[] = [];
    const continued: string[] = [];
    for (const med of signed.medications) {
      const key = medicationKey(med);
      const current = byKey.get(key);
      if (current) {
        const dosage = med.dosage ?? current.dosage;
        const frequency = med.frequency ?? current.frequency;
        const changed = dosage !== current.dosage || frequency !== current.frequency;
        await tx.medication.update({
          where: { id: current.id },
          data: { dosage, frequency, visitId: visit.id },
        });
        byKey.set(key, { ...current, dosage, frequency });
        (changed ? adjusted : continued).push(describeMedication(current.name, dosage, frequency));
      } else {
        const created = await tx.medication.create({
          data: {
            tenantId,
            patientId,
            name: med.name,
            dosage: med.dosage ?? null,
            frequency: med.frequency ?? null,
            startDate: now,
            active: true,
            visitId: visit.id,
          },
          select: { id: true, name: true, dosage: true, frequency: true },
        });
        byKey.set(key, created);
        started.push(describeMedication(created.name, created.dosage, created.frequency));
      }
    }

    // Timeline: the visit itself, one entry per new diagnosis, and one
    // prescription entry when the medication list actually changed.
    const event = (data: Omit<Prisma.TimelineEventUncheckedCreateInput, "tenantId" | "patientId" | "occurredAt" | "refId">) =>
      tx.timelineEvent.create({ data: { tenantId, patientId, refId: visit.id, occurredAt: now, ...data } });

    await event({ kind: "VISIT", title: "Consultation signed", body: summary || null });
    for (const diagnosis of addedDiagnoses) {
      await event({ kind: "DIAGNOSIS", title: `Diagnosis — ${diagnosis}`, body: null });
    }
    if (started.length || adjusted.length || stopped.length) {
      await event({
        kind: "PRESCRIPTION",
        title: "Medications updated",
        body: prescriptionSummary({ started, adjusted, stopped }),
      });
    }

    // Every overridden stop and acknowledged warning, with the clinician's
    // reason, in the same transaction as the signature.
    const overrides = resolution.accepted.length
      ? await tx.safetyOverride.createManyAndReturn({
          data: resolution.accepted.map(({ finding, reason }) => ({
            tenantId,
            consultationId: consultation.id,
            patientId,
            userId: actor.userId!,
            rule: finding.rule,
            severity: finding.severity,
            medication: finding.medication,
            message: finding.message,
            detail: toJson(finding.detail),
            reason,
            createdAt: now,
          })),
          select: { id: true, rule: true, severity: true, medication: true, message: true, reason: true },
        })
      : [];

    return {
      visitId: visit.id,
      appointmentId: appointment?.id ?? null,
      appointment: appointmentOutcome,
      addedDiagnoses,
      medications: { started, adjusted, continued, stopped },
      findings,
      overrides,
      summaryConfirmed: input.summaryConfirmed && mentions.length > 0,
    };
  });

  await audit({
    tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "consultation.sign",
    entity: "Consultation",
    entityId: consultation.id,
    before: { status: consultation.status, extraction: draft, summary: draftSummary || null },
    after: {
      status: "SIGNED",
      visitId: result.visitId,
      extraction: signed,
      summary: summary || null,
      editedByClinician,
      appointmentId: result.appointmentId,
      ...(result.appointment ? { appointmentCompleted: result.appointment.completed, appointmentStatus: result.appointment.status } : {}),
      addedDiagnoses: result.addedDiagnoses,
      medications: result.medications,
      stopMedicationIds: stopIds,
      safety: {
        findings: result.findings.map((f) => ({ rule: f.rule, severity: f.severity, medication: f.medication })),
        overrideIds: result.overrides.map((o) => o.id),
      },
      ...(result.summaryConfirmed ? { summaryConfirmed: true } : {}),
    },
  });
  for (const override of result.overrides) {
    await audit({
      tenantId,
      actorId: actor.userId,
      actorEmail: actor.email,
      ip: actor.ip,
      action: "consultation.safety_override",
      entity: "SafetyOverride",
      entityId: override.id,
      after: {
        consultationId: consultation.id,
        patientId: consultation.patientId,
        visitId: result.visitId,
        rule: override.rule,
        severity: override.severity,
        medication: override.medication,
        message: override.message,
        reason: override.reason,
      },
    });
  }

  // The clinic owner reviews every overridden stop (fire-and-forget).
  const stops = result.overrides.filter((o) => o.severity === "stop");
  if (stops.length) {
    notify(tenantId, {
      kind: "SAFETY_OVERRIDE",
      level: "WARNING",
      title: `Prescribing safety override: ${stops.map((s) => s.medication).join(", ")}`,
      body: `Signed by ${actor.email ?? "a clinician"} with the reason “${stops[0]!.reason}”. ${stops[0]!.message}`.slice(0, 1000),
      href: "/dashboard/safety",
      entity: "Consultation",
      entityId: consultation.id,
      roles: ["CLINIC_OWNER"],
      excludeUserId: actor.userId,
    }).catch(() => undefined);
  }

  // The reviews a diagnosis rule or a stated follow-up brings, and the visit closing what it served (never fails the signature).
  await safely(`recalls for signed consultation ${consultation.id}`, () => recallsOnConsultationSigned(tenantId, consultation.id, { id: actor.userId }, now));

  // Make the signed record retrievable by the assistant (fire-and-forget).
  ingestInBackground({ kind: "consultation", tenantId, id: consultation.id });
  ingestInBackground({ kind: "visit", tenantId, id: result.visitId });
  ingestInBackground({ kind: "patient", tenantId, id: consultation.patientId });

  return {
    ok: true,
    visitId: result.visitId,
    patientId: consultation.patientId,
    editedByClinician,
    addedDiagnoses: result.addedDiagnoses,
    medications: result.medications,
    appointmentId: result.appointmentId,
    appointment: result.appointment,
    safety: {
      stops: result.findings.filter((f) => f.severity === "stop").length,
      warnings: result.findings.filter((f) => f.severity === "warn").length,
      overrides: result.overrides.length,
    },
  };
}

// ── Prescribing safety check (preview) ───────────────────────────────────────

/**
 * Findings for the medications the review panel currently holds (or the
 * stored draft's), against the patient's record. Read-only; signing runs the
 * same checks again on the server.
 */
export async function checkConsultationSafety(
  tenantId: string,
  consultationId: string,
  input: SafetyCheckInput,
): Promise<SafetyCheckResponse> {
  const consultation = await db.consultation.findFirst({
    where: { id: consultationId, tenantId },
    select: { patientId: true, extraction: true },
  });
  if (!consultation) throw new ConsultationError(404, "not_found", "consultation");
  await requireTenantPatient(tenantId, consultation.patientId);
  const draft = normaliseExtraction(consultation.extraction);
  const record = await loadSafetyRecord(db, tenantId, consultation.patientId);
  return runSafetyChecks(record, {
    proposed: input.medications ?? draft.medications,
    diagnoses: input.diagnoses ?? draft.diagnoses,
    stopMedicationIds: input.stopMedicationIds,
  });
}

// ── Discarding ───────────────────────────────────────────────────────────────

/**
 * Drop a draft without touching the patient's record. Clinicians may discard
 * any pending draft of their tenant; other staff only drafts they captured.
 */
export async function discardConsultation(
  tenantId: string,
  consultationId: string,
  actor: Actor,
  opts: { canSign: boolean },
): Promise<{ ok: true; id: string; status: "DISCARDED" }> {
  const consultation = await db.consultation.findFirst({
    where: { id: consultationId, tenantId },
    select: { id: true, status: true, doctorId: true },
  });
  if (!consultation) throw new ConsultationError(404, "not_found", "consultation");
  if (!opts.canSign && (!actor.userId || consultation.doctorId !== actor.userId)) {
    throw new ConsultationError(403, "forbidden");
  }
  if (consultation.status !== "PENDING_REVIEW") throw new ConsultationError(409, "not_pending_review");

  await db.consultation.update({
    where: { id: consultation.id },
    data: { status: "DISCARDED", reviewedById: actor.userId, reviewedAt: new Date() },
  });

  await audit({
    tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "consultation.discard",
    entity: "Consultation",
    entityId: consultation.id,
    before: { status: consultation.status },
    after: { status: "DISCARDED" },
  });

  // A discarded draft must not stay retrievable.
  ingestInBackground({ kind: "consultation", tenantId, id: consultation.id });

  return { ok: true, id: consultation.id, status: "DISCARDED" };
}

// ── Reading ──────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  reviewedAt: true,
  reviewedById: true,
  visitId: true,
  doctorId: true,
  summary: true,
  patient: { select: { id: true, fullName: true } },
} satisfies Prisma.ConsultationSelect;

type ListRow = Prisma.ConsultationGetPayload<{ select: typeof listSelect }>;

/**
 * Recent consultations of the tenant. Ordered by status first — the
 * `ConsultationStatus` enum is declared in workflow order, so drafts awaiting
 * review come before signed and discarded ones — then newest first.
 */
export async function listConsultations(
  tenantId: string,
  opts: ListQuery & { page: number; pageSize: number },
): Promise<ConsultationListResponse> {
  const where: Prisma.ConsultationWhereInput = {
    tenantId,
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.patientId ? { patientId: opts.patientId } : {}),
  };
  const [total, rows] = await Promise.all([
    db.consultation.count({ where }),
    db.consultation.findMany({
      where,
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      select: listSelect,
    }),
  ]);
  const people = await loadPeople(tenantId, rows.flatMap((r) => [r.doctorId, r.reviewedById]));
  return {
    consultations: rows.map((row) => toListItem(row, people)),
    total,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

export async function getConsultation(tenantId: string, id: string): Promise<ConsultationDetail | null> {
  const row = await db.consultation.findFirst({
    where: { id, tenantId },
    select: { ...listSelect, transcript: true, extraction: true },
  });
  if (!row) return null;
  const people = await loadPeople(tenantId, [row.doctorId, row.reviewedById]);
  return {
    ...toListItem(row, people),
    transcript: row.transcript,
    extraction: normaliseExtraction(row.extraction),
    reviewedBy: person(row.reviewedById, people),
  };
}

/** Drafts of the tenant still awaiting a clinician's review. */
export function countPendingReview(tenantId: string): Promise<number> {
  return db.consultation.count({ where: { tenantId, status: "PENDING_REVIEW" } });
}

/** Active medications of a patient of the tenant, for the stop-medication checklist. */
export async function listActiveMedications(tenantId: string, patientId: string): Promise<ActiveMedication[]> {
  await requireTenantPatient(tenantId, patientId);
  const rows = await db.medication.findMany({
    where: { tenantId, patientId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, dosage: true, frequency: true, startDate: true, visitId: true },
  });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    dosage: m.dosage,
    frequency: m.frequency,
    startDate: m.startDate ? m.startDate.toISOString() : null,
    visitId: m.visitId,
  }));
}

/** The appointment must belong to the tenant and to this patient (SEC-4). */
export async function requireTenantAppointmentOfPatient(tenantId: string, patientId: string, appointmentId: string) {
  const appointment = await db.appointment.findFirst({
    where: { id: appointmentId, tenantId, patientId, ...notDeleted },
    select: { id: true, status: true, startsAt: true },
  });
  if (!appointment) throw new ConsultationError(404, "not_found", "appointment");
  return appointment;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toListItem(row: ListRow, people: Map<string, ConsultationPerson>): ConsultationListItem {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    visitId: row.visitId,
    patient: { id: row.patient.id, fullName: row.patient.fullName },
    doctor: person(row.doctorId, people),
    summary: row.summary,
  };
}

function person(id: string | null, people: Map<string, ConsultationPerson>): ConsultationPerson | null {
  if (!id) return null;
  return people.get(id) ?? { id, fullName: null };
}

/** Names of staff referenced by id (Consultation.doctorId has no relation). */
async function loadPeople(tenantId: string, ids: (string | null)[]): Promise<Map<string, ConsultationPerson>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({
    where: { tenantId, id: { in: unique } },
    select: { id: true, fullName: true, email: true },
  });
  return new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName ?? u.email }]));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Plain JSON for Prisma's Json columns (drops `undefined` optionals). */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function canonical(e: ClinicalExtraction) {
  return {
    symptoms: e.symptoms,
    diagnoses: e.diagnoses,
    medications: e.medications.map((m) => [m.name, m.dosage ?? null, m.frequency ?? null]),
    tests: e.tests,
    followUps: e.followUps,
  };
}

function sameExtraction(a: ClinicalExtraction, b: ClinicalExtraction): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function describeMedication(name: string, dosage: string | null, frequency: string | null): string {
  return [name, dosage, frequency].filter((part): part is string => Boolean(part)).join(" · ");
}

function prescriptionSummary(changes: { started: string[]; adjusted: string[]; stopped: string[] }): string {
  const parts: string[] = [];
  if (changes.started.length) parts.push(`Started: ${changes.started.join(", ")}`);
  if (changes.adjusted.length) parts.push(`Adjusted: ${changes.adjusted.join(", ")}`);
  if (changes.stopped.length) parts.push(`Stopped: ${changes.stopped.join(", ")}`);
  return parts.join("\n");
}
