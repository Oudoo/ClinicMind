import type { CheckIn, Escalation, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { answersSchema, formatAnswer, summarizeCheckIn, TRIAGE_LABEL } from "./answers";
import type { PublicCheckInDTO, PublicCheckInResult } from "./dto";
import { CheckInValidationError, ConciergeError, ConciergeNotFoundError } from "./errors";
import { openEscalation } from "./escalations";
import { dayLabel, parseSteps, pickLanguage, stepHeading, type ProtocolStep } from "./protocols";
import { firstName, getClinicInfo, type Actor } from "./shared";
import { checkInTokenHash, looksLikeToken } from "./tokens";
import { triageAnswers, type TriageFlag, type TriageLevel } from "./triage";

/**
 * A patient's answers to a check-in, through the public link or recorded by
 * staff after a phone call: validation against the step's questions, photos
 * stored as FileBlob + Document rows, triage, the CheckIn row, the task marked
 * ANSWERED, an escalation when the triage says WATCH or HIGH_RISK, a
 * notification to the nurses otherwise, the timeline line and the audit row.
 */
export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/svg+xml"]);

export interface PhotoUpload {
  /** The requested view this photo answers ("front", "top"…). */
  view?: string | null;
  name?: string | null;
  mimeType: string;
  bytes: Buffer;
}

export type CheckInSource = "link" | "staff";

export interface SubmitInput {
  answers?: unknown;
  satisfaction?: unknown;
  freeText?: unknown;
  photos?: PhotoUpload[];
  source: CheckInSource;
  actor?: Actor;
  now?: Date;
}

export interface SubmitResult {
  checkIn: CheckIn;
  taskId: string;
  enrolmentId: string;
  patientId: string;
  step: ProtocolStep;
  triage: TriageLevel;
  flags: TriageFlag[];
  escalation: Escalation | null;
  /** Minutes within which a human calls back (high-risk escalations only). */
  callbackMinutes: number | null;
}

const taskInclude = {
  enrolment: {
    include: {
      patient: { select: { id: true, fullName: true, language: true, deletedAt: true } },
      protocol: { select: { id: true, name: true, version: true, steps: true, treatment: { select: { key: true, name: true } } } },
    },
  },
} satisfies Prisma.ConciergeTaskInclude;

type LoadedTask = Prisma.ConciergeTaskGetPayload<{ include: typeof taskInclude }>;

const BodyInput = z.object({
  answers: z.record(z.string().max(64), z.unknown()).default({}),
  satisfaction: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? null : v),
    z.coerce.number({ error: "Choose 1 to 5 stars" }).int().min(1).max(5).nullable(),
  ),
  freeText: zOptionalText(2000),
});

function stepOf(task: LoadedTask): ProtocolStep {
  const step = parseSteps(task.enrolment.protocol.steps)[task.stepIndex];
  if (!step) throw new ConciergeError("no_steps", "this step no longer exists in the protocol");
  return step;
}

/** A check-in link may be answered while the enrolment runs and the task is sent (or was missed). */
function isAnswerable(task: LoadedTask, source: CheckInSource): boolean {
  if (task.enrolment.status === "STOPPED" || task.enrolment.patient.deletedAt) return false;
  if (task.kind === "INSTRUCTION") return false;
  if (source === "staff") return task.status === "PENDING" || task.status === "SENT" || task.status === "MISSED";
  return task.status === "SENT" || task.status === "MISSED";
}

// ── Public link ──────────────────────────────────────────────────────────────

async function findTaskByToken(token: string): Promise<LoadedTask | null> {
  if (!looksLikeToken(token)) return null;
  const task = await db.conciergeTask.findUnique({ where: { tokenHash: checkInTokenHash(token) }, include: taskInclude });
  return task && isAnswerable(task, "link") ? task : null;
}

/** What the public page shows for a token, or null (unknown, used, stopped: all alike). */
export async function getPublicCheckIn(token: string): Promise<PublicCheckInDTO | null> {
  const task = await findTaskByToken(token);
  if (!task) return null;
  const step = stepOf(task);
  const clinic = await getClinicInfo(task.tenantId);
  return {
    clinicName: clinic.name,
    clinicPhone: clinic.phone,
    language: pickLanguage(task.enrolment.language),
    patientFirstName: firstName(task.enrolment.patient.fullName),
    status: task.status,
    step: {
      index: task.stepIndex,
      kind: step.kind,
      title: step.title,
      dayLabel: { ar: dayLabel(step, "ar"), en: dayLabel(step, "en") },
      heading: { ar: stepHeading(step, "ar"), en: stepHeading(step, "en") },
      body: step.body,
      questions: step.questions ?? [],
      satisfaction: Boolean(step.satisfaction),
      photos: step.photos ?? [],
    },
  };
}

/** Answer through the public link. Unknown or used tokens throw `token_invalid` (404). */
export async function submitByToken(token: string, input: Omit<SubmitInput, "source">): Promise<SubmitResult> {
  const task = await findTaskByToken(token);
  if (!task) throw new ConciergeError("token_invalid", "this link is not valid", 404);
  return submitLoaded(task, { ...input, source: "link" });
}

export function toPublicResult(result: SubmitResult, clinicPhone: string | null): PublicCheckInResult {
  return { ok: true, triage: result.triage, clinicPhone, callbackMinutes: result.callbackMinutes };
}

// ── Staff ("answered by phone") ──────────────────────────────────────────────

export async function submitCheckIn(tenantId: string, taskId: string, input: SubmitInput): Promise<SubmitResult> {
  const task = await db.conciergeTask.findFirst({ where: { id: taskId, tenantId }, include: taskInclude });
  if (!task) throw new ConciergeNotFoundError("task", taskId);
  if (task.status === "ANSWERED") throw new ConciergeError("already_answered", "this check-in is already answered");
  if (!isAnswerable(task, input.source)) throw new ConciergeError("invalid_state", `a ${task.kind.toLowerCase()} task that is ${task.status} cannot be answered`);
  return submitLoaded(task, input);
}

// ── Core ─────────────────────────────────────────────────────────────────────

function validatePhotos(photos: PhotoUpload[]): void {
  if (photos.length > MAX_PHOTOS) throw new ConciergeError("too_many_photos", `At most ${MAX_PHOTOS} photos`, 422);
  for (const p of photos) {
    if (!PHOTO_MIME_TYPES.has(p.mimeType)) throw new ConciergeError("photo_type", "Photos must be JPEG, PNG, WebP or HEIC", 422);
    if (p.bytes.length > MAX_PHOTO_BYTES) throw new ConciergeError("photo_too_large", "Each photo must be 5 MB or smaller", 422);
    if (!p.bytes.length) throw new ConciergeError("photo_type", "An empty file was sent", 422);
  }
}

function flagSummary(step: ProtocolStep, flags: TriageFlag[]): string {
  const byKey = new Map((step.questions ?? []).map((q) => [q.key, q]));
  return flags
    .map((f) => {
      const q = byKey.get(f.key);
      if (f.key === "freeText" || !q) return f.label.replace(/^Free text mentions /, "free text: ");
      return `${q.key} ${formatAnswer(q, f.value)}`;
    })
    .join(", ");
}

async function submitLoaded(task: LoadedTask, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const tenantId = task.tenantId;
  const enrolment = task.enrolment;
  const step = stepOf(task);
  const source = input.source;

  // 1. Validate the body, then the answers against the step's own questions.
  const body = BodyInput.parse({ answers: input.answers ?? {}, satisfaction: input.satisfaction, freeText: input.freeText });
  const strict = source === "link";
  const parsedAnswers = answersSchema(step, { required: strict && step.kind === "CHECK_IN" }).safeParse(body.answers);
  const fieldErrors: Record<string, string[]> = {};
  if (!parsedAnswers.success) {
    for (const issue of parsedAnswers.error.issues) {
      const key = String(issue.path[0] ?? "answers");
      (fieldErrors[key] ??= []).push(issue.message);
    }
  }
  if (strict && step.satisfaction && body.satisfaction === null) fieldErrors.satisfaction = ["Choose 1 to 5 stars"];
  const photos = input.photos ?? [];
  if (strict && step.kind === "PHOTO_REQUEST" && !photos.length) fieldErrors.photos = ["Add at least one photo"];
  if (Object.keys(fieldErrors).length) throw new CheckInValidationError(fieldErrors);
  validatePhotos(photos);
  const answers = parsedAnswers.success ? parsedAnswers.data : {};

  // 2. Triage.
  const { level, flags } = triageAnswers(step, answers, body.freeText ?? null);
  const summary = summarizeCheckIn(step, { answers, satisfaction: body.satisfaction, photoCount: photos.length, triage: level });

  // 3. Store everything the patient sent.
  const checkIn = await db.$transaction(async (tx) => {
    const photoIds: string[] = [];
    for (const [i, photo] of photos.entries()) {
      const blob = await tx.fileBlob.create({
        data: { tenantId, patientId: enrolment.patientId, mimeType: photo.mimeType, sizeBytes: photo.bytes.length, bytes: photo.bytes },
        select: { id: true },
      });
      const view = photo.view?.trim() || step.photos?.[i] || `photo ${i + 1}`;
      const doc = await tx.document.create({
        data: {
          tenantId,
          patientId: enrolment.patientId,
          name: `${dayLabel(step)} ${view}${photo.name ? ` — ${photo.name.slice(0, 80)}` : ""}`,
          kind: "image",
          s3Key: `blob:${blob.id}`,
          mimeType: photo.mimeType,
          sizeBytes: photo.bytes.length,
          scanned: true,
          safe: true,
        },
        select: { id: true },
      });
      photoIds.push(doc.id);
    }
    const row = await tx.checkIn.create({
      data: {
        tenantId,
        enrolmentId: enrolment.id,
        taskId: task.id,
        patientId: enrolment.patientId,
        answers: answers as Prisma.InputJsonObject,
        satisfaction: body.satisfaction,
        freeText: body.freeText ?? null,
        photoIds,
        triage: level,
        flags: flags as unknown as Prisma.InputJsonArray,
        source,
        submittedAt: now,
      },
    });
    await tx.conciergeTask.update({ where: { id: task.id }, data: { status: "ANSWERED", answeredAt: now, lastError: null } });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: enrolment.patientId,
        kind: "CHECK_IN",
        title: `${stepHeading(step, "en")} answered · ${TRIAGE_LABEL[level]}${source === "staff" ? " (by phone)" : ""}`,
        body: summary,
        refId: row.id,
        occurredAt: now,
      },
    });
    // A late answer closes the "no answer" escalation the missed step opened.
    const missedWhere: Prisma.EscalationWhereInput = {
      tenantId,
      enrolmentId: enrolment.id,
      kind: "CONCIERGE",
      AND: [{ details: { path: ["reason"], equals: "missed" } }, { details: { path: ["taskId"], equals: task.id } }],
    };
    await tx.escalation.updateMany({
      where: { ...missedWhere, status: "OPEN" },
      data: { status: "RESOLVED", acknowledgedAt: now, resolvedAt: now, resolution: "Patient answered the check-in late" },
    });
    await tx.escalation.updateMany({
      where: { ...missedWhere, status: "ACKNOWLEDGED" },
      data: { status: "RESOLVED", resolvedAt: now, resolution: "Patient answered the check-in late" },
    });
    return row;
  });

  const actor: Actor = source === "staff" ? (input.actor ?? {}) : { id: null, email: "patient-link", ip: input.actor?.ip ?? null };
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.checkin.submit",
    entity: "CheckIn",
    entityId: checkIn.id,
    after: { taskId: task.id, enrolmentId: enrolment.id, source, triage: level, flags: flags.map((f) => f.key), photos: photos.length, satisfaction: body.satisfaction },
  });

  // 4. A human within minutes, or a quiet note to the nurses.
  let escalation: Escalation | null = null;
  let callbackMinutes: number | null = null;
  if (level !== "OK") {
    escalation = await openEscalation(tenantId, {
      level,
      summary: `${stepHeading(step, "en")}: ${flagSummary(step, flags)}`,
      patientId: enrolment.patientId,
      patientName: enrolment.patient.fullName,
      enrolmentId: enrolment.id,
      checkInId: checkIn.id,
      flags,
      details: { reason: "check-in", taskId: task.id, stepIndex: task.stepIndex, source },
      now,
      actor,
    });
    const details = escalation.details as { targetMinutes?: unknown } | null;
    callbackMinutes = level === "HIGH_RISK" && typeof details?.targetMinutes === "number" ? details.targetMinutes : null;
  } else {
    notify(tenantId, {
      kind: "CHECK_IN_ANSWERED",
      level: "INFO",
      title: `${enrolment.patient.fullName} answered the ${dayLabel(step).toLowerCase()} ${step.kind === "PHOTO_REQUEST" ? "photo request" : "check-in"} · OK`,
      body: summary,
      href: `/dashboard/concierge/enrolments/${enrolment.id}`,
      entity: "CheckIn",
      entityId: checkIn.id,
      roles: ["NURSE"],
      excludeUserId: actor.id ?? undefined,
    }).catch((err) => console.error("[concierge] check-in notification failed", err));
  }

  return { checkIn, taskId: task.id, enrolmentId: enrolment.id, patientId: enrolment.patientId, step, triage: level, flags, escalation, callbackMinutes };
}
