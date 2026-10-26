import { Prisma, type CheckIn, type Escalation } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { answersSchema, formatAnswer, summarizeCheckIn, TRIAGE_LABEL } from "./answers";
import type { PublicCheckInDTO, PublicCheckInResult } from "./dto";
import { CheckInValidationError, ConciergeError, ConciergeNotFoundError } from "./errors";
import { announceEscalation, insertEscalation, planEscalation, type EscalationPlan } from "./escalations";
import { dayLabel, parseSteps, pickLanguage, stepHeading, type ProtocolStep } from "./protocols";
import { firstName, getClinicInfo, type Actor } from "./shared";
import { checkInTokenHash, looksLikeToken } from "./tokens";
import { triageAnswers, type TriageFlag, type TriageLevel } from "./triage";

/**
 * A patient's answers to a check-in, through the public link or recorded by
 * staff after a phone call: validation against the step's questions, photos
 * stored as FileBlob + Document rows, triage, the CheckIn row, the task marked
 * ANSWERED (claimed atomically, so a double tap never stores two), an
 * escalation in the same transaction when the triage says WATCH or HIGH_RISK,
 * a notification to the nurses otherwise, the timeline line and the audit row.
 */
export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** The page downsizes photos to this longest side (JPEG) before upload. */
export const MAX_PHOTO_SIDE = 1600;
/**
 * The whole JSON request (base64 photos included). The request proxy buffers
 * at most 10 MB of a body, so the public endpoint refuses anything larger
 * up front instead of reading a truncated one.
 */
export const MAX_BODY_BYTES = 9 * 1024 * 1024;
/** Public endpoint budgets per client address, per 15 minutes (a patient retrying after a validation error stays well inside). */
export const CHECK_IN_RATE_WINDOW_MS = 15 * 60_000;
export const CHECK_IN_PUBLIC_GET_LIMIT = 60;
export const CHECK_IN_PUBLIC_POST_LIMIT = 20;
/** A link answers for this long after its message went out (late answers to a missed step included). */
export const LINK_TTL_MS = 7 * 86_400_000;
/** Raster formats only: an SVG could carry script and is never accepted. */
export const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"]);

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
  outOfHours: boolean;
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
    z.coerce.number({ error: "Choose 1 to 5 stars" }).int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars").nullable(),
  ),
  freeText: zOptionalText(2000),
});

function stepOf(task: LoadedTask): ProtocolStep {
  const step = parseSteps(task.enrolment.protocol.steps)[task.stepIndex];
  if (!step) throw new ConciergeError("no_steps", "this step no longer exists in the protocol");
  return step;
}

/** Statuses a task may be answered from: the patient's link needs it sent (or missed), staff may record ahead. */
function answerableStatuses(source: CheckInSource): ("PENDING" | "SENT" | "MISSED")[] {
  return source === "staff" ? ["PENDING", "SENT", "MISSED"] : ["SENT", "MISSED"];
}

/**
 * A check-in may be answered while the enrolment has not been stopped, the
 * patient is on file and the task is open. The link additionally expires
 * seven days after its message went out.
 */
function isAnswerable(task: LoadedTask, source: CheckInSource, now: Date): boolean {
  if (task.enrolment.status === "STOPPED" || task.enrolment.patient.deletedAt) return false;
  if (task.kind === "INSTRUCTION") return false;
  if (!(answerableStatuses(source) as string[]).includes(task.status)) return false;
  if (source === "link" && (!task.sentAt || now.getTime() - task.sentAt.getTime() > LINK_TTL_MS)) return false;
  return true;
}

// ── Photos ───────────────────────────────────────────────────────────────────

/** The image type from the first bytes (never the client's word for it), or null. */
export function sniffImageType(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i] ?? -1;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x89 && ascii(1, 4) === "PNG" && b(4) === 0x0d && b(5) === 0x0a) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "hevx", "heim", "heis"].includes(brand)) return "image/heic";
    if (["mif1", "msf1", "heif"].includes(brand)) return "image/heif";
  }
  return null;
}

const PhotoPayload = z.object({
  view: z.string().trim().max(40).nullable().optional(),
  name: z.string().trim().max(120).nullable().optional(),
  type: z.string().trim().max(60).nullable().optional(),
  /** Base64, with or without a `data:image/…;base64,` prefix. */
  data: z.string().min(1, "An empty photo was sent"),
});

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/**
 * Photos as JSON (`[{ view, name, type, data }]`, data in base64) → uploads,
 * typed by their magic bytes. Throws 422 `ConciergeError`s with a code the
 * page can explain (too many, too large, not an image).
 */
export function parsePhotoPayload(raw: unknown): PhotoUpload[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConciergeError("photo_type", "Photos must be a list", 422);
  if (raw.length > MAX_PHOTOS) throw new ConciergeError("too_many_photos", `At most ${MAX_PHOTOS} photos`, 422);
  return raw.map((item) => {
    const parsed = PhotoPayload.safeParse(item);
    if (!parsed.success) throw new ConciergeError("photo_type", "A photo could not be read", 422);
    const data = parsed.data.data.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    // Reject before decoding anything that is obviously too big (4 base64 characters carry 3 bytes).
    if (Math.floor((data.length * 3) / 4) > MAX_PHOTO_BYTES + 3) throw new ConciergeError("photo_too_large", "Each photo must be 5 MB or smaller", 422);
    if (!BASE64.test(data)) throw new ConciergeError("photo_type", "A photo could not be read", 422);
    const bytes = Buffer.from(data, data.includes("-") || data.includes("_") ? "base64url" : "base64");
    const mimeType = sniffImageType(bytes) ?? parsed.data.type ?? "application/octet-stream";
    return { view: parsed.data.view ?? null, name: parsed.data.name ?? null, mimeType, bytes };
  });
}

function validatePhotos(photos: PhotoUpload[]): void {
  if (photos.length > MAX_PHOTOS) throw new ConciergeError("too_many_photos", `At most ${MAX_PHOTOS} photos`, 422);
  for (const p of photos) {
    if (!p.bytes.length) throw new ConciergeError("photo_type", "An empty file was sent", 422);
    if (p.bytes.length > MAX_PHOTO_BYTES) throw new ConciergeError("photo_too_large", "Each photo must be 5 MB or smaller", 422);
    // Whatever the client claims, the bytes decide: only real raster images are stored.
    const sniffed = sniffImageType(p.bytes);
    if (!sniffed || !PHOTO_MIME_TYPES.has(sniffed)) throw new ConciergeError("photo_type", "Photos must be JPEG, PNG, WebP or HEIC", 422);
    p.mimeType = sniffed;
  }
}

// ── Public link ──────────────────────────────────────────────────────────────

async function findTaskByToken(token: string, now: Date): Promise<LoadedTask | null> {
  if (!looksLikeToken(token)) return null;
  const task = await db.conciergeTask.findUnique({ where: { tokenHash: checkInTokenHash(token) }, include: taskInclude });
  return task && isAnswerable(task, "link", now) ? task : null;
}

/** What the public page shows for a token, or null (unknown, used, expired, stopped: all alike). */
export async function getPublicCheckIn(token: string, now = new Date()): Promise<PublicCheckInDTO | null> {
  const task = await findTaskByToken(token, now);
  if (!task) return null;
  const step = stepOf(task);
  const clinic = await getClinicInfo(task.tenantId);
  return {
    clinicName: clinic.name,
    clinicPhone: clinic.phone,
    language: pickLanguage(task.enrolment.language),
    patientFirstName: firstName(task.enrolment.patient.fullName),
    status: task.status,
    late: task.status === "MISSED",
    limits: { maxPhotos: MAX_PHOTOS, maxPhotoBytes: MAX_PHOTO_BYTES, maxBodyBytes: MAX_BODY_BYTES, maxPhotoSide: MAX_PHOTO_SIDE },
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

/** Answer through the public link. Unknown, used or expired tokens throw `token_invalid` (404). */
export async function submitByToken(token: string, input: Omit<SubmitInput, "source">): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const task = await findTaskByToken(token, now);
  if (!task) throw new ConciergeError("token_invalid", "this link is not valid", 404);
  return submitLoaded(task, { ...input, now, source: "link" });
}

export function toPublicResult(result: SubmitResult, clinicPhone: string | null): PublicCheckInResult {
  return { ok: true, triage: result.triage, clinicPhone, callbackMinutes: result.callbackMinutes, outOfHours: result.outOfHours };
}

// ── Staff ("answered by phone") ──────────────────────────────────────────────

export async function submitCheckIn(tenantId: string, taskId: string, input: SubmitInput): Promise<SubmitResult> {
  const now = input.now ?? new Date();
  const task = await db.conciergeTask.findFirst({ where: { id: taskId, tenantId }, include: taskInclude });
  if (!task) throw new ConciergeNotFoundError("task", taskId);
  if (task.status === "ANSWERED") throw new ConciergeError("already_answered", "this check-in is already answered");
  if (!isAnswerable(task, input.source, now)) throw new ConciergeError("invalid_state", `a ${task.kind.toLowerCase().replace("_", " ")} task that is ${task.status} cannot be answered`);
  return submitLoaded(task, { ...input, now });
}

// ── Core ─────────────────────────────────────────────────────────────────────

function flagSummary(step: ProtocolStep, flags: TriageFlag[]): string {
  const byKey = new Map((step.questions ?? []).map((q) => [q.key, q]));
  return flags
    .map((f) => {
      const q = byKey.get(f.key);
      if (f.key === "freeText" || !q) return f.label.replace(/^Free text mentions /, "free text: ");
      if (q.type === "text") return f.label;
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

  // 2. Triage, and who hears about it (read before the transaction).
  const { level, flags } = triageAnswers(step, answers, body.freeText ?? null);
  const summary = summarizeCheckIn(step, { answers, satisfaction: body.satisfaction, photoCount: photos.length, triage: level });
  const actor: Actor = source === "staff" ? (input.actor ?? {}) : { id: null, email: "patient-link", ip: input.actor?.ip ?? null };
  const plan: EscalationPlan | null =
    level === "OK"
      ? null
      : await planEscalation(tenantId, {
          level,
          summary: `${stepHeading(step, "en")}: ${flagSummary(step, flags)}`,
          patientId: enrolment.patientId,
          patientName: enrolment.patient.fullName,
          enrolmentId: enrolment.id,
          flags,
          details: { reason: "check-in", taskId: task.id, stepIndex: task.stepIndex, source },
          now,
          actor,
        });

  // 3. Store everything the patient sent, the task claimed first so a second submit finds nothing to answer.
  let stored: { checkIn: CheckIn; escalation: Escalation | null };
  try {
    stored = await db.$transaction(
      async (tx) => {
        const claimed = await tx.conciergeTask.updateMany({
          where: { id: task.id, tenantId, status: { in: answerableStatuses(source) } },
          data: { status: "ANSWERED", answeredAt: now, lastError: null, tokenHash: null },
        });
        if (!claimed.count) {
          throw source === "link"
            ? new ConciergeError("token_invalid", "this link is not valid", 404)
            : new ConciergeError("already_answered", "this check-in is already answered");
        }
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
        // The escalation commits with the answer: a high-risk reply is never stored without one.
        const escalation = plan ? await insertEscalation(tx, tenantId, { ...plan, input: { ...plan.input, checkInId: row.id } }) : null;
        return { checkIn: row, escalation };
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    // The CheckIn's unique taskId is the last line of defence against a double submit.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw source === "link" ? new ConciergeError("token_invalid", "this link is not valid", 404) : new ConciergeError("already_answered", "this check-in is already answered");
    }
    throw err;
  }
  const { checkIn, escalation } = stored;

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
  if (escalation && plan) {
    await announceEscalation(tenantId, escalation, { ...plan, input: { ...plan.input, checkInId: checkIn.id } });
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

  return {
    checkIn,
    taskId: task.id,
    enrolmentId: enrolment.id,
    patientId: enrolment.patientId,
    step,
    triage: level,
    flags,
    escalation,
    callbackMinutes: level === "HIGH_RISK" && plan ? plan.minutes : null,
    outOfHours: plan?.outOfHours ?? false,
  };
}
