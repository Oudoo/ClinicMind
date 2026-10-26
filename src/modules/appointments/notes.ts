import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText, zText } from "@/lib/validation";
import { AppointmentNotFoundError, attachNoteAuthors, type Actor } from "./service";
import { APPOINTMENT_NOTE_KINDS, MAX_NOTE_LENGTH, NOTE_LANGUAGES } from "./transitions";

/**
 * Dictated (or typed) notes dropped onto an appointment: kept with the booking,
 * written to the patient timeline as an AUDIO event, carried into the
 * consultation workspace. Removing one is a soft delete ("dropping" it in the
 * other sense) that only the author or a user manager may do; the body stays
 * in the row and the audit log, the timeline entry stays as history.
 */

export const MAX_NOTE_DURATION_SECONDS = 15 * 60;

export const AppointmentNoteInput = z.object({
  body: zText(MAX_NOTE_LENGTH).min(1, "Say or type something first"),
  kind: z.enum(APPOINTMENT_NOTE_KINDS).default("DICTATION"),
  language: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.enum(NOTE_LANGUAGES).optional()),
  durationSeconds: z.number().int().min(0).max(MAX_NOTE_DURATION_SECONDS).optional(),
  /** Unused by the API; accepted so a form can post its whole state. */
  appointmentId: zOptionalText(64),
});
export type AppointmentNoteInput = z.infer<typeof AppointmentNoteInput>;

export class AppointmentNoteNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
  constructor(readonly id: string) {
    super(`note ${id} not found in tenant`);
    this.name = "AppointmentNoteNotFoundError";
  }
}

/** Only the author of a note, or a user manager, may remove it. */
export class AppointmentNoteForbiddenError extends Error {
  readonly status = 403;
  readonly code = "forbidden";
  constructor() {
    super("Only the author of a note or a user manager can remove it");
    this.name = "AppointmentNoteForbiddenError";
  }
}

const TIMELINE_TITLE = { DICTATION: "Dictated note on the appointment", TEXT: "Typed note on the appointment" } as const;

async function requireAppointment(tenantId: string, appointmentId: string) {
  const appointment = await db.appointment.findFirst({
    where: { id: appointmentId, tenantId, ...notDeleted },
    select: { id: true, patientId: true },
  });
  if (!appointment) throw new AppointmentNotFoundError(appointmentId);
  return appointment;
}

/** Live notes of one appointment, oldest first, with their authors. */
export async function listAppointmentNotes(tenantId: string, appointmentId: string) {
  await requireAppointment(tenantId, appointmentId);
  const rows = await db.appointmentNote.findMany({
    where: { tenantId, appointmentId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return attachNoteAuthors(tenantId, rows);
}

export async function createAppointmentNote(tenantId: string, appointmentId: string, rawInput: unknown, actor: Actor = {}) {
  const input = AppointmentNoteInput.parse(rawInput);
  const appointment = await requireAppointment(tenantId, appointmentId);
  const language = input.language && input.language !== "auto" ? input.language : null;

  const note = await db.$transaction(async (tx) => {
    const note = await tx.appointmentNote.create({
      data: {
        tenantId,
        appointmentId,
        patientId: appointment.patientId,
        kind: input.kind,
        body: input.body,
        language,
        durationSeconds: input.kind === "DICTATION" ? (input.durationSeconds ?? null) : null,
        authorId: actor.id ?? null,
      },
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: appointment.patientId,
        kind: "AUDIO",
        title: TIMELINE_TITLE[input.kind],
        body: input.body,
        refId: appointmentId,
        occurredAt: note.createdAt,
      },
    });
    return note;
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.note.create",
    entity: "AppointmentNote",
    entityId: note.id,
    after: { appointmentId, patientId: appointment.patientId, kind: note.kind, language: note.language, durationSeconds: note.durationSeconds, length: note.body.length },
  });

  const [withAuthor] = await attachNoteAuthors(tenantId, [note]);
  return withAuthor ?? { ...note, author: null };
}

export async function deleteAppointmentNote(
  tenantId: string,
  appointmentId: string,
  noteId: string,
  actor: Actor = {},
  opts: { canManage?: boolean } = {},
) {
  const note = await db.appointmentNote.findFirst({
    where: { id: noteId, appointmentId, tenantId, deletedAt: null },
  });
  if (!note) throw new AppointmentNoteNotFoundError(noteId);
  const isAuthor = Boolean(actor.id) && note.authorId === actor.id;
  if (!isAuthor && !opts.canManage) throw new AppointmentNoteForbiddenError();

  const now = new Date();
  await db.appointmentNote.update({
    where: { id: note.id },
    data: { deletedAt: now, deletedById: actor.id ?? null },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.note.delete",
    entity: "AppointmentNote",
    entityId: note.id,
    before: { appointmentId, kind: note.kind, language: note.language, durationSeconds: note.durationSeconds, length: note.body.length, authorId: note.authorId },
    after: { deletedAt: now, deletedById: actor.id ?? null },
  });
  return { id: note.id, appointmentId, deletedAt: now };
}
