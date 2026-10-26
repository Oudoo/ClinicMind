import type { ChannelType, ObjectionTag } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText, zText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { createLead } from "@/modules/crm/service";
import { CHANNELS, channelToSource, normalisePhone } from "@/modules/crm/shared";
import { tagObjections } from "./tagger";

/**
 * Inbound messages from the connected channel (WhatsApp Cloud webhook or the
 * clinic's inbox webhook). The handler finds or opens the thread, stores the
 * message, suggests objection tags, opens a lead for an unknown contact and
 * tells the assigned receptionist. Idempotent on the provider's message id.
 */
export interface InboundMessage {
  channel: ChannelType;
  /** Sender phone in any common format; normalised to E.164. */
  from: string;
  name?: string | null;
  body: string;
  /** The provider's message id (dedupes retries). */
  externalId?: string | null;
  /** The provider's thread / contact id (WhatsApp wa_id, chat session id). */
  conversationExternalId?: string | null;
  /** Campaign reference (`ref` / `campaign` in the payload): matched against Campaign.externalId. */
  ref?: string | null;
  locale?: string | null;
  receivedAt?: Date | null;
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** The generic JSON an inbox webhook posts to `/api/integrations/messaging/inbound/<slug>`. */
export const InboundPayload = z
  .object({
    channel: z.preprocess(blankToUndefined, z.enum(CHANNELS).default("WHATSAPP")),
    from: zText(40).min(5, "from (phone) is required"),
    name: zOptionalText(120),
    body: zText(4000).min(1, "body is required"),
    externalId: zOptionalText(160),
    messageId: zOptionalText(160),
    conversationId: zOptionalText(160),
    threadId: zOptionalText(160),
    ref: zOptionalText(160),
    campaign: zOptionalText(160),
    locale: z.preprocess(blankToUndefined, z.enum(["ar", "en"]).optional()),
    receivedAt: zOptionalText(40),
  })
  .transform(
    (p): InboundMessage => ({
      channel: p.channel,
      from: p.from,
      name: p.name ?? null,
      body: p.body,
      externalId: p.externalId ?? p.messageId ?? null,
      conversationExternalId: p.conversationId ?? p.threadId ?? null,
      ref: p.ref ?? p.campaign ?? null,
      locale: p.locale ?? null,
      receivedAt: p.receivedAt && !Number.isNaN(Date.parse(p.receivedAt)) ? new Date(p.receivedAt) : null,
    }),
  );

/**
 * Messages inside a Meta webhook delivery (`entry[].changes[].value.messages[]`).
 * Non-text messages are kept as a short placeholder so the thread shows them.
 */
export function parseMetaPayload(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = payload as { entry?: unknown } | null;
  const entries = Array.isArray(root?.entry) ? root!.entry : [];
  for (const entry of entries as { changes?: unknown }[]) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes as { field?: string; value?: Record<string, unknown> }[]) {
      const value = change?.value;
      if (!value || typeof value !== "object") continue;
      const contacts = Array.isArray(value.contacts) ? (value.contacts as { wa_id?: string; profile?: { name?: string } }[]) : [];
      const nameOf = new Map(contacts.map((c) => [c.wa_id ?? "", c.profile?.name ?? null]));
      const messages = Array.isArray(value.messages) ? (value.messages as Record<string, unknown>[]) : [];
      for (const m of messages) {
        const from = typeof m.from === "string" ? m.from : null;
        if (!from) continue;
        const type = typeof m.type === "string" ? m.type : "text";
        const text = (m.text as { body?: string } | undefined)?.body;
        const caption = (m[type] as { caption?: string } | undefined)?.caption;
        const body = type === "text" ? (text ?? "") : `[${type}]${caption ? ` ${caption}` : ""}`;
        if (!body.trim()) continue;
        const ts = typeof m.timestamp === "string" ? Number(m.timestamp) * 1000 : NaN;
        const referral = m.referral as { source_id?: string; source_url?: string } | undefined;
        out.push({
          channel: "WHATSAPP",
          from,
          name: nameOf.get(from) ?? null,
          body: body.slice(0, 4000),
          externalId: typeof m.id === "string" ? m.id : null,
          conversationExternalId: from,
          ref: referral?.source_id ?? null,
          locale: null,
          receivedAt: Number.isFinite(ts) ? new Date(ts) : null,
        });
      }
    }
  }
  return out;
}

export interface InboundResult {
  conversationId: string;
  messageId: string;
  leadId: string | null;
  patientId: string | null;
  createdConversation: boolean;
  createdLead: boolean;
  duplicate: boolean;
  objections: ObjectionTag[];
}

/** Store an inbound message for the tenant (see module doc). */
export async function handleInbound(tenantId: string, msg: InboundMessage): Promise<InboundResult> {
  const phone = normalisePhone(msg.from);
  const now = msg.receivedAt ?? new Date();

  if (msg.externalId) {
    const existing = await db.message.findFirst({
      where: { tenantId, externalId: msg.externalId, direction: "INBOUND" },
      select: { id: true, conversationId: true, conversation: { select: { leadId: true, patientId: true, objections: true } } },
    });
    if (existing) {
      return {
        conversationId: existing.conversationId,
        messageId: existing.id,
        leadId: existing.conversation.leadId,
        patientId: existing.conversation.patientId,
        createdConversation: false,
        createdLead: false,
        duplicate: true,
        objections: existing.conversation.objections,
      };
    }
  }

  // The thread: by the provider's thread id, else the latest thread of this number on the channel.
  let conversation = msg.conversationExternalId
    ? await db.conversation.findFirst({ where: { tenantId, channel: msg.channel, externalId: msg.conversationExternalId }, orderBy: { updatedAt: "desc" } })
    : null;
  if (!conversation) {
    conversation = await db.conversation.findFirst({ where: { tenantId, channel: msg.channel, contactPhone: phone }, orderBy: { updatedAt: "desc" } });
  }

  const [patient, lead] = await Promise.all([
    conversation?.patientId
      ? db.patient.findFirst({ where: { id: conversation.patientId, tenantId }, select: { id: true, fullName: true, language: true } })
      : db.patient.findFirst({ where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] }, select: { id: true, fullName: true, language: true } }),
    conversation?.leadId
      ? db.lead.findFirst({ where: { id: conversation.leadId, tenantId }, select: { id: true, fullName: true } })
      : db.lead.findFirst({ where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] }, orderBy: { createdAt: "desc" }, select: { id: true, fullName: true } }),
  ]);

  let createdConversation = false;
  if (!conversation) {
    conversation = await db.conversation.create({
      data: {
        tenantId,
        channel: msg.channel,
        externalId: msg.conversationExternalId ?? null,
        patientId: patient?.id ?? null,
        leadId: lead?.id ?? null,
        contactName: msg.name ?? patient?.fullName ?? lead?.fullName ?? null,
        contactPhone: phone,
        locale: msg.locale ?? patient?.language ?? "ar",
        status: "WAITING_ON_CLINIC",
        createdAt: now,
      },
    });
    createdConversation = true;
  }

  const message = await db.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      direction: "INBOUND",
      body: msg.body,
      author: "PATIENT",
      delivery: "DELIVERED",
      externalId: msg.externalId ?? null,
      deliveredAt: now,
      createdAt: now,
    },
    select: { id: true },
  });

  // Objection suggestions (the AI's job online; the keyword tagger offline). Confirmed tags are left alone.
  const suggested = tagObjections(msg.body) as ObjectionTag[];
  const objections = conversation.objectionsConfirmedAt ? conversation.objections : ([...new Set([...conversation.objections, ...suggested])] as ObjectionTag[]);

  await db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastInboundAt: now,
      status: "WAITING_ON_CLINIC",
      closedAt: null,
      objections,
      patientId: conversation.patientId ?? patient?.id ?? null,
      leadId: conversation.leadId ?? lead?.id ?? null,
      contactName: conversation.contactName ?? msg.name ?? null,
      externalId: conversation.externalId ?? msg.conversationExternalId ?? null,
      updatedAt: now,
    },
  });

  // Unknown contact: a lead opens itself so nobody falls through the cracks.
  let leadId = conversation.leadId ?? lead?.id ?? null;
  let createdLead = false;
  if (!leadId && !patient && !conversation.patientId) {
    const campaign = msg.ref ? await db.campaign.findFirst({ where: { tenantId, externalId: msg.ref }, select: { id: true, source: true } }) : null;
    const created = await createLead(
      tenantId,
      {
        fullName: msg.name?.trim() || phone,
        phone,
        source: campaign?.source ?? channelToSource(msg.channel),
        campaignId: campaign?.id,
        conversationId: conversation.id,
        notes: `Opened from an inbound ${msg.channel === "WHATSAPP" ? "WhatsApp" : msg.channel.toLowerCase()} message.`,
      },
      {},
      { via: "webhook" },
    );
    leadId = created.id;
    createdLead = true;
  }

  const displayName = patient?.fullName ?? lead?.fullName ?? msg.name ?? phone;
  notify(tenantId, {
    kind: "MESSAGE_INBOUND",
    title: `New message from ${displayName}`,
    body: msg.body.length > 140 ? `${msg.body.slice(0, 137)}…` : msg.body,
    href: `/dashboard/conversations?c=${conversation.id}`,
    entity: "Conversation",
    entityId: conversation.id,
    userIds: conversation.assignedToId ? [conversation.assignedToId] : [],
    roles: conversation.assignedToId ? [] : ["RECEPTIONIST"],
  }).catch((err) => console.error("[messaging] MESSAGE_INBOUND notification failed", err));

  db.channelIntegration.updateMany({ where: { tenantId, channel: msg.channel }, data: { lastInboundAt: now } }).catch(() => undefined);

  if (createdConversation) {
    await audit({
      tenantId,
      action: "conversation.inbound.open",
      entity: "Conversation",
      entityId: conversation.id,
      after: { channel: msg.channel, contactPhone: phone, patientId: patient?.id ?? null, leadId },
    });
  }

  return {
    conversationId: conversation.id,
    messageId: message.id,
    leadId,
    patientId: conversation.patientId ?? patient?.id ?? null,
    createdConversation,
    createdLead,
    duplicate: false,
    objections,
  };
}
