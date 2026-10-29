import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { normalizeText } from "@/modules/assistant/text";
import { sendPatientMessage } from "./outbound";

/**
 * A patient's own word on WhatsApp about the clinic's automatic messages:
 * "STOP" (or إلغاء, وقف…) turns off treatment reminders and offers alike;
 * "START" turns treatment reminders back on (offers stay as they were: a
 * yes to offers is asked for, not assumed). Only a message that is just
 * that word counts; anything longer goes to the inbox. Claimed inside the
 * inbound message's transaction, acknowledged and audited after it.
 */

export type ConsentAnswer = "stop" | "start";

type Client = Prisma.TransactionClient;

const STOP = new Set(["stop", "unsubscribe", "الغاء", "الغي", "وقف", "توقف", "ايقاف", "كفايه", "بطل"]);
const START = new Set(["start", "subscribe", "unstop", "ابدا", "تفعيل", "رجوع"]);
const MAX = 24;

export function readConsentReply(body: string): ConsentAnswer | null {
  if (!body || body.length > MAX) return null;
  const words = normalizeText(body)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length !== 1) return null;
  const word = words[0]!;
  if (STOP.has(word)) return "stop";
  if (START.has(word)) return "start";
  return null;
}

export interface ClaimedConsent {
  answer: ConsentAnswer;
  patientId: string;
  /** False when it was already so (nothing changed, nothing to say). */
  changed: boolean;
}

export async function claimConsentReply(tx: Client, tenantId: string, patientId: string, body: string, at: Date): Promise<ClaimedConsent | null> {
  const answer = readConsentReply(body);
  if (!answer) return null;
  const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId }, select: { reminderConsent: true, marketingConsent: true } });
  if (!patient) return null;
  const changed = answer === "stop" ? patient.reminderConsent || patient.marketingConsent : !patient.reminderConsent;
  if (!changed) return { answer, patientId, changed: false };
  await tx.patient.update({
    where: { id: patientId, tenantId },
    data:
      answer === "stop"
        ? { reminderConsent: false, reminderConsentAt: at, ...(patient.marketingConsent ? { marketingConsent: false, marketingConsentAt: at } : {}) }
        : { reminderConsent: true, reminderConsentAt: at },
  });
  await tx.timelineEvent.create({
    data: {
      tenantId,
      patientId,
      kind: "WHATSAPP_MESSAGE",
      title: answer === "stop" ? "Asked on WhatsApp for no more reminders or offers" : "Asked on WhatsApp for reminders again",
      occurredAt: at,
    },
  });
  return { answer, patientId, changed: true };
}

export function consentAckText(answer: ConsentAnswer, language: string | null | undefined): string {
  if (language === "en") {
    return answer === "stop"
      ? "Done: you won't get reminders or offers from us on WhatsApp any more. Reply START to have appointment reminders again."
      : "Done: you'll get appointment and treatment reminders on WhatsApp again. Reply STOP to turn them off.";
  }
  return answer === "stop"
    ? "تمام، مش هيوصلك مننا تذكيرات أو عروض على واتساب تاني. ابعت START لو حابب ترجع تذكيرات المواعيد."
    : "تمام، هترجع توصلك تذكيرات المواعيد والعلاج على واتساب. ابعت STOP لو حابب توقفها.";
}

/** After the inbound message committed: audit the change and tell the patient it is done. */
export async function finishConsentReply(tenantId: string, claimed: ClaimedConsent, ctx: { messageId: string; conversationId: string; language: string | null }): Promise<void> {
  if (!claimed.changed) return;
  await audit({
    tenantId,
    action: claimed.answer === "stop" ? "patient.consent.withdraw" : "patient.consent.give",
    entity: "Patient",
    entityId: claimed.patientId,
    after: { via: "whatsapp", messageId: ctx.messageId, ...(claimed.answer === "stop" ? { reminderConsent: false, marketingConsent: false } : { reminderConsent: true }) },
  });
  try {
    await sendPatientMessage(tenantId, {
      patientId: claimed.patientId,
      conversationId: ctx.conversationId,
      body: consentAckText(claimed.answer, ctx.language),
      channel: "WHATSAPP",
      templateKey: claimed.answer === "stop" ? "consent:stopped" : "consent:started",
      author: "SYSTEM",
      meta: { kind: "consent-ack" },
    });
  } catch (err) {
    console.error("[messaging] could not acknowledge a consent reply", err);
  }
}
