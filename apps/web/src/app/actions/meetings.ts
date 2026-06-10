"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, meetings, clients, sowDocuments, prerequisiteForms } from "@growengine/db";
import { audit, publishEvent, EVENT_TYPES, uploadObject } from "@growengine/core";
import { requirePermission } from "@/lib/session";
import { createAiJob } from "@/lib/jobs";

const meetingSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  agenda: z.string().max(5000).optional(),
  scheduledAt: z.string().optional(),
});

export async function createMeeting(formData: FormData) {
  const user = await requirePermission("meetings:manage");
  const parsed = meetingSchema.safeParse({
    clientId: formData.get("clientId"),
    title: formData.get("title"),
    agenda: formData.get("agenda") || undefined,
    scheduledAt: formData.get("scheduledAt") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, parsed.data.clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  // Attach the most specific active prerequisite form (client > global)
  const forms = await db
    .select()
    .from(prerequisiteForms)
    .where(and(eq(prerequisiteForms.tenantId, user.tenantId), eq(prerequisiteForms.isActive, 1)));
  const form =
    forms.find((f) => f.clientId === client.id) ?? forms.find((f) => f.clientId === null);

  const [meeting] = await db
    .insert(meetings)
    .values({
      tenantId: user.tenantId,
      clientId: client.id,
      title: parsed.data.title,
      agenda: parsed.data.agenda,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
      organizerId: user.id,
      prerequisiteFormId: form?.id ?? null,
      status: form ? "awaiting_prereqs" : "scheduled",
    })
    .returning();

  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "meeting.create",
    entityType: "meeting",
    entityId: meeting.id,
  });
  revalidatePath("/meetings");
  return { ok: true, meetingId: meeting.id };
}

export async function savePrerequisiteResponses(meetingId: string, formData: FormData) {
  const user = await requirePermission("meetings:manage");
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, user.tenantId)));
  if (!meeting) return { error: "Meeting not found" };

  const responses: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("field_")) responses[key.slice(6)] = String(value);
  }
  await db
    .update(meetings)
    .set({ prerequisiteResponses: responses, status: "scheduled", updatedAt: new Date() })
    .where(eq(meetings.id, meetingId));
  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true };
}

/** Upload a meeting recording to object storage and queue analysis. */
export async function uploadRecording(meetingId: string, formData: FormData) {
  const user = await requirePermission("meetings:manage");
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, user.tenantId)));
  if (!meeting) return { error: "Meeting not found" };

  const file = formData.get("recording") as File | null;
  if (!file || file.size === 0) return { error: "No recording file provided" };
  if (file.size > 500 * 1024 * 1024) return { error: "Recording exceeds 500MB limit" };

  const ext = file.name.split(".").pop() ?? "mp3";
  const key = `${user.tenantId}/meetings/${meetingId}/recording.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await uploadObject(key, buffer, file.type || "audio/mpeg");

  await db
    .update(meetings)
    .set({
      recordingStorageKey: key,
      recordingMimeType: file.type,
      status: "recorded",
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, meetingId));

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.meetingRecorded,
    entityType: "meeting",
    entityId: meetingId,
    payload: { clientId: meeting.clientId },
  });

  // Queue the full pipeline: transcribe → extract → baseline
  await createAiJob(user.tenantId, meeting.clientId, "meeting_analysis", { meetingId });

  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true };
}

export async function reanalyzeMeeting(meetingId: string) {
  const user = await requirePermission("meetings:manage");
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, user.tenantId)));
  if (!meeting) return { error: "Meeting not found" };
  await createAiJob(user.tenantId, meeting.clientId, "meeting_analysis", { meetingId });
  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true };
}

/** Generate an SOW from an analyzed meeting. */
export async function generateSow(meetingId: string) {
  const user = await requirePermission("meetings:manage");
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, meetingId), eq(meetings.tenantId, user.tenantId)));
  if (!meeting) return { error: "Meeting not found" };
  if (meeting.status !== "analyzed") return { error: "Meeting must be analyzed first" };

  const [sow] = await db
    .insert(sowDocuments)
    .values({
      tenantId: user.tenantId,
      clientId: meeting.clientId,
      meetingId,
      title: `SOW — ${meeting.title}`,
      createdBy: user.id,
    })
    .returning();

  await createAiJob(user.tenantId, meeting.clientId, "sow", { meetingId, sowId: sow.id });
  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true, sowId: sow.id };
}

const prereqFormSchema = z.object({
  name: z.string().min(2).max(120),
  clientId: z.string().uuid().optional().or(z.literal("")),
  fieldsJson: z.string(),
});

export async function createPrerequisiteForm(formData: FormData) {
  const user = await requirePermission("meetings:manage");
  const parsed = prereqFormSchema.safeParse({
    name: formData.get("name"),
    clientId: formData.get("clientId") || "",
    fieldsJson: formData.get("fieldsJson"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  let fields: unknown[];
  try {
    fields = JSON.parse(parsed.data.fieldsJson);
    if (!Array.isArray(fields)) throw new Error();
  } catch {
    return { error: "Fields must be a JSON array of {key,label,type,required}" };
  }

  await db.insert(prerequisiteForms).values({
    tenantId: user.tenantId,
    clientId: parsed.data.clientId || null,
    name: parsed.data.name,
    fields,
  });
  revalidatePath("/meetings");
  return { ok: true };
}
