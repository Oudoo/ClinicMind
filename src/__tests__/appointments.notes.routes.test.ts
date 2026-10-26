/**
 * Notes dictated (or typed) onto an appointment, over the real route handlers
 * and the test database: create with the AUDIO timeline event and the audit
 * entry, list (oldest first, authors attached, carried on the appointment the
 * consultation opens), remove under the author-or-manager rule, RBAC and
 * tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as listAppointmentsRoute } from "@/app/api/appointments/route";
import { GET as getAppointmentRoute } from "@/app/api/appointments/[id]/route";
import { GET as listNotesRoute, POST as createNoteRoute } from "@/app/api/appointments/[id]/notes/route";
import { DELETE as deleteNoteRoute } from "@/app/api/appointments/[id]/notes/[noteId]/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const noteParams = (id: string, noteId: string) => ({ params: Promise.resolve({ id, noteId }) });

type NoteJson = {
  id: string;
  appointmentId: string;
  patientId: string;
  kind: "DICTATION" | "TEXT";
  body: string;
  language: string | null;
  durationSeconds: number | null;
  author: { id: string; fullName: string } | null;
};

describe.skipIf(!dbTestsEnabled)("appointment notes", () => {
  const created: string[] = [];
  let a: string;
  let owner: { id: string };
  let desk: { id: string };
  let desk2: { id: string };
  let doctor: { id: string };
  let ownerCookie: string;
  let deskCookie: string;
  let desk2Cookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let patient: string;
  let appointment: string;
  let other: string;
  let deskNote: string;
  let doctorNote: string;

  async function createNote(appointmentId: string, body: unknown, cookie = deskCookie) {
    const res = await createNoteRoute(request(`/api/appointments/${appointmentId}/notes`, { method: "POST", cookie, body }), idParams(appointmentId));
    return { res, json: await res.json() };
  }

  async function listNotes(appointmentId: string, cookie = deskCookie) {
    const res = await listNotesRoute(request(`/api/appointments/${appointmentId}/notes`, { cookie }), idParams(appointmentId));
    return { res, json: (await res.json()) as { notes: NoteJson[] } };
  }

  async function removeNote(appointmentId: string, noteId: string, cookie = deskCookie) {
    const res = await deleteNoteRoute(
      request(`/api/appointments/${appointmentId}/notes/${noteId}`, { method: "DELETE", cookie }),
      noteParams(appointmentId, noteId),
    );
    return { res, json: await res.json() };
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `notes-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `notes-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA.id;
    owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    desk = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk One" });
    desk2 = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk Two" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Notes" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant" });
    const ownerB = await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    deskCookie = await sessionCookieFor(desk.id);
    desk2Cookie = await sessionCookieFor(desk2.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);

    patient = (await db.patient.create({ data: { tenantId: a, fullName: "Hala Zaki" } })).id;
    const start = new Date("2030-02-03T08:00:00Z");
    appointment = (
      await db.appointment.create({
        data: { tenantId: a, patientId: patient, doctorId: doctor.id, startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000) },
      })
    ).id;
    other = (
      await db.appointment.create({
        data: { tenantId: a, patientId: patient, doctorId: doctor.id, startsAt: new Date("2030-02-04T08:00:00Z"), endsAt: new Date("2030-02-04T08:30:00Z") },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("saves a dictated note with its language and length, an AUDIO timeline event and an audit entry", async () => {
    const body = "المريضة هتتأخر عشر دقايق ومعاها نتايج التحاليل.";
    const { res, json } = await createNote(appointment, { body: `  ${body}  `, kind: "DICTATION", language: "ar", durationSeconds: 12 });
    expect(res.status).toBe(201);
    expect(json.note).toMatchObject({ appointmentId: appointment, patientId: patient, kind: "DICTATION", body, language: "ar", durationSeconds: 12, author: { id: desk.id, fullName: "Desk One" } });
    deskNote = json.note.id;

    const events = await db.timelineEvent.findMany({ where: { tenantId: a, patientId: patient, kind: "AUDIO" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: "Dictated note on the appointment", body, refId: appointment });
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "appointment.note.create", entityId: deskNote } });
    expect(audit).toMatchObject({ actorId: desk.id, entity: "AppointmentNote" });
    expect(audit.after).toMatchObject({ appointmentId: appointment, patientId: patient, kind: "DICTATION", language: "ar", durationSeconds: 12, length: body.length });
  });

  it("saves a typed note; 'auto' stores no language and a typed note has no recording length", async () => {
    const { res, json } = await createNote(appointment, { body: "Compare the scalp photos with day 7.", kind: "TEXT", language: "auto", durationSeconds: 30 }, doctorCookie);
    expect(res.status).toBe(201);
    expect(json.note).toMatchObject({ kind: "TEXT", language: null, durationSeconds: null, author: { id: doctor.id } });
    doctorNote = json.note.id;
    const event = await db.timelineEvent.findFirstOrThrow({ where: { tenantId: a, kind: "AUDIO", body: "Compare the scalp photos with day 7." } });
    expect(event.title).toBe("Typed note on the appointment");
  });

  it("validates the note", async () => {
    for (const body of [
      { body: "" },
      { body: "   " },
      { body: "x".repeat(5001) },
      { body: "ok", kind: "VIDEO" },
      { body: "ok", language: "fr" },
      { body: "ok", durationSeconds: -1 },
      { body: "ok", durationSeconds: 15 * 60 + 1 },
      { body: "ok", durationSeconds: 1.5 },
    ]) {
      const { res, json } = await createNote(appointment, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect(json.error).toBe("validation_error");
    }
    expect((await createNote(appointment, { body: "x".repeat(5000) })).res.status).toBe(201);
  });

  it("lists the live notes oldest first with their authors, and the appointment carries them for the consultation", async () => {
    const { res, json } = await listNotes(appointment);
    expect(res.status).toBe(200);
    expect(json.notes.map((n) => n.id).slice(0, 2)).toEqual([deskNote, doctorNote]);
    expect(json.notes[1]!.author).toEqual({ id: doctor.id, fullName: "Dr. Notes" });

    const one = await (await getAppointmentRoute(request(`/api/appointments/${appointment}`, { cookie: doctorCookie }), idParams(appointment))).json();
    expect(one.appointment.notesCount).toBe(3);
    expect(one.appointment.dictatedNotes.map((n: NoteJson) => n.id).slice(0, 2)).toEqual([deskNote, doctorNote]);
    const week = await (
      await listAppointmentsRoute(request("/api/appointments?from=2030-02-01T00:00:00Z&to=2030-02-07T00:00:00Z", { cookie: deskCookie }))
    ).json();
    const counts = Object.fromEntries(week.appointments.map((x: { id: string; notesCount: number }) => [x.id, x.notesCount]));
    expect(counts).toEqual({ [appointment]: 3, [other]: 0 });
  });

  it("an assistant reads the notes but cannot add or remove one (403)", async () => {
    expect((await listNotes(appointment, assistantCookie)).res.status).toBe(200);
    const add = await createNote(appointment, { body: "Assistant note" }, assistantCookie);
    expect(add.res.status).toBe(403);
    const remove = await removeNote(appointment, deskNote, assistantCookie);
    expect(remove.res.status).toBe(403);
    expect(await db.appointmentNote.count({ where: { tenantId: a, deletedAt: null } })).toBe(3);
  });

  it("only the author or a user manager removes a note; another receptionist gets 403", async () => {
    const forbidden = await removeNote(appointment, deskNote, desk2Cookie);
    expect(forbidden.res.status).toBe(403);
    expect(forbidden.json.error).toBe("forbidden");
    // A doctor is not a user manager either.
    expect((await removeNote(appointment, deskNote, doctorCookie)).res.status).toBe(403);

    const own = await removeNote(appointment, deskNote, deskCookie);
    expect(own.res.status).toBe(200);
    expect(own.json).toMatchObject({ ok: true, id: deskNote, appointmentId: appointment });

    const managed = await removeNote(appointment, doctorNote, ownerCookie);
    expect(managed.res.status).toBe(200);

    const row = await db.appointmentNote.findUniqueOrThrow({ where: { id: doctorNote } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedById).toBe(owner.id);
    // Soft delete: the text stays in the row and in history, the audit says who removed it.
    expect(row.body).toBe("Compare the scalp photos with day 7.");
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "appointment.note.delete", entityId: doctorNote } });
    expect(audit.actorId).toBe(owner.id);
    expect(audit.before).toMatchObject({ appointmentId: appointment, kind: "TEXT", authorId: doctor.id });
    expect(await db.timelineEvent.count({ where: { tenantId: a, patientId: patient, kind: "AUDIO" } })).toBe(3);
  });

  it("a removed note disappears from the list and the count, and cannot be removed twice", async () => {
    const { json } = await listNotes(appointment);
    expect(json.notes.map((n) => n.id)).not.toContain(deskNote);
    expect(json.notes).toHaveLength(1);
    const one = await (await getAppointmentRoute(request(`/api/appointments/${appointment}`, { cookie: deskCookie }), idParams(appointment))).json();
    expect(one.appointment.notesCount).toBe(1);
    expect((await removeNote(appointment, deskNote, deskCookie)).res.status).toBe(404);
  });

  it("a note is addressed through its own appointment only", async () => {
    const { json } = await createNote(appointment, { body: "Pinned to the first booking" });
    const wrong = await removeNote(other, json.note.id, deskCookie);
    expect(wrong.res.status).toBe(404);
    expect(wrong.json).toMatchObject({ error: "not_found", entity: "note" });
  });

  it("another tenant gets 404 for the appointment and its notes, and writes nothing", async () => {
    const list = await listNotes(appointment, ownerBCookie);
    expect(list.res.status).toBe(404);
    const add = await createNote(appointment, { body: "From the other clinic" }, ownerBCookie);
    expect(add.res.status).toBe(404);
    expect(add.json).toMatchObject({ error: "not_found", entity: "appointment" });
    const live = await db.appointmentNote.findFirstOrThrow({ where: { tenantId: a, deletedAt: null } });
    expect((await removeNote(appointment, live.id, ownerBCookie)).res.status).toBe(404);
    expect(await db.appointmentNote.count({ where: { body: "From the other clinic" } })).toBe(0);
    expect((await db.appointmentNote.findUniqueOrThrow({ where: { id: live.id } })).deletedAt).toBeNull();
  });

  it("an unknown appointment is a 404 and every route needs a session and a same-origin write", async () => {
    expect((await createNote("nope", { body: "x" })).res.status).toBe(404);
    expect((await listNotes("nope")).res.status).toBe(404);
    expect((await listNotesRoute(request(`/api/appointments/${appointment}/notes`), idParams(appointment))).status).toBe(401);
    const cross = await createNoteRoute(
      request(`/api/appointments/${appointment}/notes`, { method: "POST", cookie: deskCookie, body: { body: "x" }, headers: { origin: "https://evil.example" } }),
      idParams(appointment),
    );
    expect(cross.status).toBe(403);
  });
});
