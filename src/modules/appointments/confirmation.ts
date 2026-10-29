import type { MessageDelivery, Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { formatDateInTz } from "@/lib/time";
import { normalizeText } from "@/modules/assistant/text";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import type { ConfirmationRequestDTO } from "./dto";

/**
 * A moved appointment asks the patient to confirm the new time.
 *
 * When the desk moves a booking to another time it goes back to Scheduled
 * (unconfirmed) and, unless the desk unticks it, the patient gets a WhatsApp
 * message in their language with the new day, time and doctor: "reply 1 to
 * confirm, or 2 if this time doesn't suit you". The reply comes back through
 * the inbound webhook (`claimConfirmationReply` inside the message's own
 * transaction, then `finishConfirmationReply`):
 *  - 1 (yes, ok, نعم, تمام, أيوه, 👍 …) confirms the booking and thanks the
 *    patient; nothing is left for reception to do, so no notification;
 *  - 2 (no, لا …) leaves it unconfirmed, tells the patient the clinic will be
 *    in touch, and tells reception;
 *  - anything else is an ordinary message for the inbox.
 * Only a short reply that is clearly one or the other counts; "yes but can we
 * make it 6?" goes to a person.
 */

export type ConfirmationAnswer = "confirm" | "decline";

type Language = "ar" | "en";
type Client = Prisma.TransactionClient;

const CONFIRM_WORDS = new Set([
  "1",
  "yes",
  "y",
  "yeah",
  "yep",
  "ok",
  "okay",
  "confirm",
  "confirmed",
  "sure",
  "نعم",
  "ايوه",
  "ايوا",
  "اه",
  "تمام",
  "تم",
  "اكيد",
  "موافق",
  "ماشي",
]);
const DECLINE_WORDS = new Set(["2", "no", "n", "nope", "لا", "لاء"]);
/** Politeness around the answer ("ok thanks", "تمام شكرا") does not change it. */
const FILLER_WORDS = new Set(["thanks", "thank", "you", "thx", "please", "pls", "شكرا", "ميرسي", "مرسي", "جزيلا", "يا", "فندم", "دكتور"]);
const MAX_REPLY_LENGTH = 60;

/** "confirm", "decline" or null (not a clear answer: a person reads it). */
export function readConfirmationReply(body: string): ConfirmationAnswer | null {
  if (!body || body.length > MAX_REPLY_LENGTH) return null;
  const text = normalizeText(body)
    .replace(/👍|✅|☑️|✔️|👌/gu, " yes ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = text.split(/\s+/).filter((w) => w && !FILLER_WORDS.has(w));
  if (!words.length) return null;
  if (words.every((w) => CONFIRM_WORDS.has(w))) return "confirm";
  if (words.every((w) => DECLINE_WORDS.has(w))) return "decline";
  return null;
}

// ── Wording ──────────────────────────────────────────────────────────────────

function languageOf(code: string | null | undefined): Language {
  return code === "en" ? "en" : "ar";
}

function firstNameOf(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

/** "Tuesday 10 November at 5:30 pm" / "الثلاثاء 10 نوفمبر الساعة 5:30 م" on the clinic clock. */
export function patientWhen(date: Date, timezone: string, language: Language): string {
  const locale = language === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  const day = formatDateInTz(date, timezone, { weekday: "long", day: "numeric", month: "long" }, locale).replace("،", "");
  const time = new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(date);
  return language === "ar" ? `${day} الساعة ${time}` : `${day} at ${time}`;
}

export function confirmationRequestText(input: {
  language: Language;
  patientName: string;
  clinicName: string;
  startsAt: Date;
  timezone: string;
  doctorName: string | null;
}): string {
  const first = firstNameOf(input.patientName);
  const when = patientWhen(input.startsAt, input.timezone, input.language);
  if (input.language === "ar") {
    const doctor = input.doctorName ? ` مع ${input.doctorName}` : "";
    return `أهلاً ${first}، ميعادك في ${input.clinicName} اتغير ليوم ${when}${doctor}. ابعت 1 للتأكيد، أو 2 لو الميعاد ده مش مناسب.`;
  }
  const doctor = input.doctorName ? ` with ${input.doctorName}` : "";
  return `Hi ${first}, your appointment at ${input.clinicName} has moved to ${when}${doctor}. Reply 1 to confirm, or 2 if this time doesn't suit you.`;
}

export function confirmationAckText(answer: ConfirmationAnswer, input: { language: Language; patientName: string; startsAt: Date; timezone: string }): string {
  const first = firstNameOf(input.patientName);
  const when = patientWhen(input.startsAt, input.timezone, input.language);
  if (input.language === "ar") {
    return answer === "confirm"
      ? `شكراً يا ${first}، ميعادك يوم ${when} اتأكد. في انتظارك.`
      : `شكراً إنك بلغتنا يا ${first}. فريقنا هيتواصل معاك قريب علشان نختار ميعاد يناسبك.`;
  }
  return answer === "confirm"
    ? `Thank you, ${first}. Your appointment on ${when} is confirmed. See you then.`
    : `Thanks for letting us know, ${first}. Our team will be in touch shortly to find a time that suits you.`;
}

// ── Asking ───────────────────────────────────────────────────────────────────

/** `requested`: the booking now waits for the patient's answer; see ConfirmationRequestDTO. */
export interface ConfirmationRequest extends ConfirmationRequestDTO {
  delivery: MessageDelivery | null;
}

interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

/**
 * Ask the patient to confirm the moved appointment's new time (called once the
 * move has committed). A failure to deliver leaves nothing pending: reception
 * calls instead, and the result says why.
 */
export async function requestConfirmation(
  tenantId: string,
  appointment: { id: string; patientId: string; startsAt: Date; doctorId: string | null },
  ctx: { timezone: string; actor: Actor; now?: Date },
): Promise<ConfirmationRequest> {
  const [patient, tenant, doctor] = await Promise.all([
    db.patient.findFirst({ where: { id: appointment.patientId, tenantId, ...notDeleted }, select: { fullName: true, phone: true, whatsapp: true, language: true } }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    appointment.doctorId ? db.user.findFirst({ where: { id: appointment.doctorId, tenantId }, select: { fullName: true } }) : null,
  ]);
  if (!patient || !(patient.whatsapp || patient.phone)) {
    return { requested: false, delivery: null, reason: "no_phone", conversationId: null };
  }
  const body = confirmationRequestText({
    language: languageOf(patient.language),
    patientName: patient.fullName,
    clinicName: tenant?.name ?? "the clinic",
    startsAt: appointment.startsAt,
    timezone: ctx.timezone,
    doctorName: doctor?.fullName ?? null,
  });
  const sent = await sendPatientMessage(tenantId, {
    patientId: appointment.patientId,
    body,
    channel: "WHATSAPP",
    templateKey: "appointment:confirm-new-time",
    author: "SYSTEM",
    meta: { appointmentId: appointment.id, kind: "confirmation-request" },
  });
  const requested = sent.delivery !== "FAILED";
  if (requested) {
    await db.appointment.updateMany({
      where: { id: appointment.id, tenantId, status: "SCHEDULED" },
      data: { confirmationRequestedAt: ctx.now ?? new Date() },
    });
  }
  const reason = requested
    ? null
    : ((await db.message.findFirst({ where: { id: sent.messageId, tenantId }, select: { failedReason: true } }))?.failedReason ?? "delivery failed");
  await audit({
    tenantId,
    actorId: ctx.actor.id ?? null,
    actorEmail: ctx.actor.email ?? null,
    ip: ctx.actor.ip ?? null,
    action: "appointment.confirmation.request",
    entity: "Appointment",
    entityId: appointment.id,
    patientId: appointment.patientId,
    after: { startsAt: appointment.startsAt.toISOString(), delivery: sent.delivery, messageId: sent.messageId, conversationId: sent.conversationId, ...(reason ? { reason } : {}) },
  });
  return { requested, delivery: sent.delivery, reason, conversationId: sent.conversationId };
}

// ── The patient's answer ─────────────────────────────────────────────────────

export interface ClaimedReply {
  answer: ConfirmationAnswer;
  appointmentId: string;
  patientId: string;
  startsAt: Date;
  /** The booking the reply answered: false when it had moved on (nothing changed). */
  applied: boolean;
  /** What asked: a reminder (appointments/reminders.ts) or a moved time. */
  via: "reminder" | "move";
}

/**
 * Inside the inbound message's transaction: read the reply and apply it to
 * the patient's latest pending request for a booking still ahead. Returns null
 * when the message is not a clear answer or nothing is pending.
 */
export async function claimConfirmationReply(tx: Client, tenantId: string, patientId: string, body: string, at: Date): Promise<ClaimedReply | null> {
  const answer = readConfirmationReply(body);
  if (!answer) return null;
  const pending = await tx.appointment.findFirst({
    where: { tenantId, patientId, ...notDeleted, status: "SCHEDULED", confirmationRequestedAt: { lte: at }, startsAt: { gt: at } },
    orderBy: { confirmationRequestedAt: "desc" },
    select: { id: true, startsAt: true, confirmationRequestedAt: true, reminderSentAt: true, finalReminderSentAt: true },
  });
  if (!pending) return null;
  // A reminder stamps its time and the request together.
  const asked = pending.confirmationRequestedAt?.getTime();
  const via = asked !== undefined && (asked === pending.reminderSentAt?.getTime() || asked === pending.finalReminderSentAt?.getTime()) ? "reminder" : "move";
  // Conditional on the state just read, so a reply racing a move or a manual confirmation changes nothing.
  const changed = await tx.appointment.updateMany({
    where: { id: pending.id, tenantId, status: "SCHEDULED", startsAt: pending.startsAt, confirmationRequestedAt: { not: null } },
    data:
      answer === "confirm"
        ? { status: "CONFIRMED", confirmedAt: at, statusChangedAt: at, confirmationRequestedAt: null, rescheduleRequestedAt: null }
        : { confirmationRequestedAt: null, rescheduleRequestedAt: at },
  });
  if (changed.count === 0) return { answer, appointmentId: pending.id, patientId, startsAt: pending.startsAt, applied: false, via };
  const what = via === "reminder" ? "appointment" : "new appointment time";
  await tx.timelineEvent.create({
    data: {
      tenantId,
      patientId,
      kind: "APPOINTMENT",
      title: answer === "confirm" ? `Confirmed the ${what} on WhatsApp` : "Asked for another appointment time on WhatsApp",
      refId: pending.id,
      occurredAt: at,
    },
  });
  return { answer, appointmentId: pending.id, patientId, startsAt: pending.startsAt, applied: true, via };
}

/**
 * After the inbound message committed: audit the answer and thank the
 * patient. Returns the notification reception should get instead of the
 * generic "new message" one (null: none, the booking took care of itself).
 */
export async function finishConfirmationReply(
  tenantId: string,
  claimed: ClaimedReply,
  ctx: { messageId: string; conversationId: string; timezone: string },
): Promise<{ title: string; body: string } | null> {
  if (!claimed.applied) return null;
  const patient = await db.patient.findFirst({ where: { id: claimed.patientId, tenantId }, select: { fullName: true, language: true } });
  await audit({
    tenantId,
    action: claimed.answer === "confirm" ? "appointment.confirm" : "appointment.confirmation.decline",
    entity: "Appointment",
    entityId: claimed.appointmentId,
    patientId: claimed.patientId,
    after: { via: "whatsapp", messageId: ctx.messageId, startsAt: claimed.startsAt.toISOString(), ...(claimed.answer === "confirm" ? { status: "CONFIRMED" } : {}) },
  });
  const name = patient?.fullName ?? "The patient";
  try {
    await sendPatientMessage(tenantId, {
      patientId: claimed.patientId,
      conversationId: ctx.conversationId,
      body: confirmationAckText(claimed.answer, { language: languageOf(patient?.language), patientName: name, startsAt: claimed.startsAt, timezone: ctx.timezone }),
      channel: "WHATSAPP",
      templateKey: claimed.answer === "confirm" ? "appointment:confirmed-thanks" : "appointment:another-time-thanks",
      author: "SYSTEM",
      meta: { appointmentId: claimed.appointmentId, kind: "confirmation-ack" },
    });
  } catch (err) {
    console.error("[appointments] could not thank the patient for the confirmation reply", err);
  }
  if (claimed.answer === "confirm") return null;
  return {
    title: claimed.via === "reminder" ? `${name} asks for another time` : `${name} can't make the new time`,
    body: `${patientWhen(claimed.startsAt, ctx.timezone, "en")}: ${claimed.via === "reminder" ? "answered 2 to the reminder" : "asked for another time on WhatsApp"}. Call to rebook (Recalls → Contact today).`,
  };
}
