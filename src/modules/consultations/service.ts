import { z } from "zod";
import { NextResponse } from "next/server";
import type { AppointmentStatus, Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { handleApiError } from "@/lib/api";
import { requireTenantPatient } from "@/lib/tenant-scope";
import {
  ClinicalExtractionSchema,
  MAX_EXTRACTION_ITEMS,
  normaliseClinicalTerm,
  normaliseExtraction,
  type ClinicalExtraction,
} from "@/lib/ai/extraction";
import {
  CONSULTATION_STATUSES,
  SUMMARY_MAX_LENGTH,
  type ActiveMedication,
  type ConsultationDetail,
  type ConsultationListItem,
  type ConsultationListResponse,
  type ConsultationPerson,
  type ConsultationStatus,
  type SignResponse,
} from "./types";

/**
 * Consultation Intelligence domain service: review-before-sign.
 *
 * A consultation is captured (transcript + AI draft) as PENDING_REVIEW and
 * nothing reaches the patient's clinical record until a clinician signs it.
 * Signing is one transaction that creates the immutable Visit, appends only
 * new diagnoses, reconciles medications against the patient's active list and
 * emits timeline events; the audit row records the AI draft next to what was
 * actually signed so reviewers can see what the clinician changed.
 */

export const STOP_REASON_ON_SIGN = "Stopped at consultation sign";

const TERMINAL_APPOINTMENT_STATUSES: ReadonlySet<AppointmentStatus> = new Set<AppointmentStatus>([
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
]);

/** Domain failure with its HTTP mapping; `entity` names what was not found. */
export class ConsultationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly entity?: string,
  ) {
    super(entity ? `${code} (${entity})` : code);
    this.name = "ConsultationError";
  }
}

/** Route-handler error mapping: domain errors first, then the shared mapping. */
export function handleConsultationError(err: unknown): NextResponse {
  if (err instanceof ConsultationError) {
    return NextResponse.json(
      { error: err.code, ...(err.entity ? { entity: err.entity } : {}) },
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

export const SignInput = z.object({
  summary: z.string().trim().max(SUMMARY_MAX_LENGTH).optional(),
  extraction: ClinicalExtractionSchema.optional(),
  appointmentId: zId.optional(),
  stopMedicationIds: z.array(zId).max(MAX_EXTRACTION_ITEMS).default([]),
});
export type SignInput = z.infer<typeof SignInput>;

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

  const result = await db.$transaction(async (tx) => {
    // Re-prove the patient belongs to this tenant inside the transaction
    // (SEC-4): everything below is appended to that patient's record.
    await requireTenantPatient(tenantId, consultation.patientId, tx);
    const patientId = consultation.patientId;

    // The linked appointment must be the tenant's AND this patient's; a foreign
    // or mismatched id is indistinguishable from a missing one.
    let appointment: { id: string; status: AppointmentStatus } | null = null;
    if (input.appointmentId) {
      const found = await tx.appointment.findFirst({
        where: { id: input.appointmentId, tenantId, patientId, ...notDeleted },
        select: { id: true, status: true, visit: { select: { id: true } } },
      });
      if (!found) throw new ConsultationError(404, "not_found", "appointment");
      if (found.visit) throw new ConsultationError(409, "appointment_already_signed");
      appointment = { id: found.id, status: found.status };
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

    if (appointment && !TERMINAL_APPOINTMENT_STATUSES.has(appointment.status)) {
      await tx.appointment.update({
        where: { id: appointment.id },
        data: { status: "COMPLETED", statusChangedAt: now },
      });
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
    if (stopIds.length) {
      const rows = await tx.medication.findMany({
        where: { id: { in: stopIds }, tenantId, patientId },
        select: { id: true, name: true, active: true },
      });
      if (rows.length !== stopIds.length) throw new ConsultationError(404, "not_found", "medication");
      for (const row of rows) {
        if (!row.active) continue; // already stopped: nothing to change
        await tx.medication.update({
          where: { id: row.id },
          data: { active: false, stoppedAt: now, stopReason: STOP_REASON_ON_SIGN },
        });
        stopped.push(row.name);
      }
    }

    // Reconcile: an active medication with the same normalised name is
    // updated (dosage/frequency when stated, and the visit link) instead of
    // being duplicated; anything else is a new prescription of this visit.
    const active = await tx.medication.findMany({
      where: { tenantId, patientId, active: true },
      select: { id: true, name: true, dosage: true, frequency: true },
    });
    const byName = new Map(active.map((m) => [normaliseClinicalTerm(m.name), m]));
    const started: string[] = [];
    const adjusted: string[] = [];
    const continued: string[] = [];
    for (const med of signed.medications) {
      const key = normaliseClinicalTerm(med.name);
      const current = byName.get(key);
      if (current) {
        const dosage = med.dosage ?? current.dosage;
        const frequency = med.frequency ?? current.frequency;
        const changed = dosage !== current.dosage || frequency !== current.frequency;
        await tx.medication.update({
          where: { id: current.id },
          data: { dosage, frequency, visitId: visit.id },
        });
        byName.set(key, { ...current, dosage, frequency });
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
        byName.set(key, created);
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

    return {
      visitId: visit.id,
      appointmentId: appointment?.id ?? null,
      addedDiagnoses,
      medications: { started, adjusted, continued, stopped },
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
      addedDiagnoses: result.addedDiagnoses,
      medications: result.medications,
      stopMedicationIds: stopIds,
    },
  });

  return {
    ok: true,
    visitId: result.visitId,
    patientId: consultation.patientId,
    editedByClinician,
    addedDiagnoses: result.addedDiagnoses,
    medications: result.medications,
    appointmentId: result.appointmentId,
  };
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
