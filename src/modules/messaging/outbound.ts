import type { ChannelType, MessageDelivery } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { normalisePhone } from "@/modules/crm/shared";
import { deliverOutbound } from "./provider";

/**
 * One door for every outbound patient message (concierge steps, reminders,
 * inbox replies). The messaging module owns delivery: WhatsApp Cloud API or
 * the clinic's inbox webhook when the tenant's channel is connected
 * (modules/messaging/provider.ts), otherwise the message is written to the
 * patient's conversation with delivery LOGGED so the record (and the demo)
 * still shows what would have gone out. Callers never deal with providers.
 */
export interface OutboundMessage {
  patientId?: string | null;
  /** E.164 phone when no patient is linked (a lead). */
  phone?: string | null;
  body: string;
  channel?: ChannelType;
  templateKey?: string | null;
  /** Who is sending: a staff id, or null for the system / AI. */
  authorId?: string | null;
  author?: "HUMAN" | "AI" | "SYSTEM";
  /** Reuse this conversation instead of finding one by patient / phone. */
  conversationId?: string | null;
  meta?: Record<string, unknown>;
}

export interface OutboundResult {
  conversationId: string;
  messageId: string;
  delivery: MessageDelivery;
}

/**
 * Send (or log) a message. Finds or creates the conversation for the patient
 * or phone on the channel, stores the outbound Message and returns how it was
 * delivered. Never throws for a provider problem: a failed send is stored with
 * delivery FAILED and `failedReason`.
 */
export async function sendPatientMessage(tenantId: string, input: OutboundMessage): Promise<OutboundResult> {
  const channel = input.channel ?? "WHATSAPP";
  const phone = input.phone ? normalisePhone(input.phone) : null;

  let conversation: { id: string; contactPhone: string | null; patientId: string | null; leadId: string | null } | null = null;
  if (input.conversationId) {
    conversation = await db.conversation.findFirst({
      where: { id: input.conversationId, tenantId },
      select: { id: true, contactPhone: true, patientId: true, leadId: true },
    });
  }
  if (!conversation && (input.patientId || phone)) {
    conversation = await db.conversation.findFirst({
      where: {
        tenantId,
        channel,
        ...(input.patientId ? { patientId: input.patientId } : { contactPhone: phone }),
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true, contactPhone: true, patientId: true, leadId: true },
    });
  }
  if (!conversation) {
    const patient = input.patientId
      ? await db.patient.findFirst({
          where: { id: input.patientId, tenantId, ...notDeleted },
          select: { id: true, fullName: true, phone: true, whatsapp: true, language: true },
        })
      : phone
        ? await db.patient.findFirst({
            where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] },
            select: { id: true, fullName: true, phone: true, whatsapp: true, language: true },
          })
        : null;
    const lead =
      !patient && phone
        ? await db.lead.findFirst({ where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] }, orderBy: { createdAt: "desc" }, select: { id: true, fullName: true } })
        : null;
    conversation = await db.conversation.create({
      data: {
        tenantId,
        channel,
        patientId: patient?.id ?? null,
        leadId: lead?.id ?? null,
        contactName: patient?.fullName ?? lead?.fullName ?? null,
        contactPhone: phone ?? patient?.whatsapp ?? patient?.phone ?? null,
        locale: patient?.language ?? "ar",
        status: "WAITING_ON_PATIENT",
      },
      select: { id: true, contactPhone: true, patientId: true, leadId: true },
    });
  }

  const author = input.author ?? (input.authorId ? "HUMAN" : "SYSTEM");
  const message = await db.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      direction: "OUTBOUND",
      body: input.body,
      author,
      authorId: input.authorId ?? null,
      templateKey: input.templateKey ?? null,
      delivery: "QUEUED",
      meta: (input.meta ?? undefined) as never,
    },
    select: { id: true },
  });

  const result = await deliverOutbound({
    tenantId,
    channel,
    to: phone ?? conversation.contactPhone,
    body: input.body,
    messageId: message.id,
    conversationId: conversation.id,
    meta: input.meta,
  });

  const now = new Date();
  await db.$transaction([
    db.message.update({
      where: { id: message.id },
      data: { delivery: result.delivery, externalId: result.externalId, failedReason: result.failedReason },
    }),
    db.conversation.update({
      where: { id: conversation.id },
      data: { lastOutboundAt: now, updatedAt: now, status: "WAITING_ON_PATIENT", closedAt: null },
    }),
  ]);
  if (conversation.leadId && author === "HUMAN") {
    db.lead.updateMany({ where: { id: conversation.leadId, tenantId }, data: { lastContactAt: now } }).catch(() => undefined);
  }

  if (result.delivery === "LOGGED") {
    console.info(`[messaging] (no channel connected — message logged on conversation ${conversation.id})\n  | ${input.body.split("\n").join("\n  | ")}`);
  } else if (result.delivery === "FAILED") {
    console.warn(`[messaging] ${result.provider} delivery failed for message ${message.id}: ${result.failedReason}`);
  }
  return { conversationId: conversation.id, messageId: message.id, delivery: result.delivery };
}
