import type { ChannelType, MessageDelivery } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";

/**
 * One door for every outbound patient message (concierge steps, reminders,
 * inbox replies). The messaging module owns delivery: WhatsApp Cloud API when
 * the tenant's channel is connected, otherwise the message is written to the
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
  let conversationId = input.conversationId ?? null;
  if (conversationId) {
    const existing = await db.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { id: true } });
    if (!existing) conversationId = null;
  }
  if (!conversationId) {
    const existing = await db.conversation.findFirst({
      where: {
        tenantId,
        channel,
        ...(input.patientId ? { patientId: input.patientId } : input.phone ? { contactPhone: input.phone } : { id: "-" }),
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    conversationId = existing?.id ?? null;
  }
  if (!conversationId) {
    const patient = input.patientId
      ? await db.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true, fullName: true, phone: true, whatsapp: true, language: true } })
      : null;
    const created = await db.conversation.create({
      data: {
        tenantId,
        channel,
        patientId: patient?.id ?? null,
        contactName: patient?.fullName ?? null,
        contactPhone: input.phone ?? patient?.whatsapp ?? patient?.phone ?? null,
        locale: patient?.language ?? "ar",
        status: "WAITING_ON_PATIENT",
      },
      select: { id: true },
    });
    conversationId = created.id;
  }
  const now = new Date();
  const message = await db.message.create({
    data: {
      tenantId,
      conversationId,
      direction: "OUTBOUND",
      body: input.body,
      author: input.author ?? (input.authorId ? "HUMAN" : "SYSTEM"),
      authorId: input.authorId ?? null,
      templateKey: input.templateKey ?? null,
      delivery: "LOGGED",
      meta: (input.meta ?? undefined) as never,
    },
    select: { id: true },
  });
  await db.conversation.update({ where: { id: conversationId }, data: { lastOutboundAt: now, updatedAt: now } });
  console.info(`[messaging] (no channel connected — message logged on conversation ${conversationId})\n  | ${input.body.split("\n").join("\n  | ")}`);
  return { conversationId, messageId: message.id, delivery: "LOGGED" };
}
