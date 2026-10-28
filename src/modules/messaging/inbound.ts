import type { ChannelType, ObjectionTag } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText, zText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { createLead } from "@/modules/crm/service";
import { CHANNELS, channelToSource, normalisePhone, type LeadSourceKey } from "@/modules/crm/shared";
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
  const arrived = new Date();
  // The provider's timestamp is kept, unless it claims to come from the future.
  const now = msg.receivedAt && msg.receivedAt.getTime() <= arrived.getTime() ? msg.receivedAt : arrived;

  const stored = await db.$transaction(async (tx) => {
    // One contact's messages are stored one at a time: a provider retry or a
    // burst from a new number must not race into a duplicate message or into
    // two threads for the same person.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inbound:${tenantId}:${msg.channel}:${phone}`}))`;

    if (msg.externalId) {
      const existing = await tx.message.findFirst({
        where: { tenantId, externalId: msg.externalId, direction: "INBOUND" },
        select: { id: true, conversationId: true, conversation: { select: { leadId: true, patientId: true, objections: true } } },
      });
      if (existing) {
        const result: InboundResult = {
          conversationId: existing.conversationId,
          messageId: existing.id,
          leadId: existing.conversation.leadId,
          patientId: existing.conversation.patientId,
          createdConversation: false,
          createdLead: false,
          duplicate: true,
          objections: existing.conversation.objections,
        };
        return { duplicate: true as const, result };
      }
    }

    // The thread: by the provider's thread id, else the latest thread of this number on the channel.
    let conversation = msg.conversationExternalId
      ? await tx.conversation.findFirst({ where: { tenantId, channel: msg.channel, externalId: msg.conversationExternalId }, orderBy: { updatedAt: "desc" } })
      : null;
    if (!conversation) {
      conversation = await tx.conversation.findFirst({ where: { tenantId, channel: msg.channel, contactPhone: phone }, orderBy: { updatedAt: "desc" } });
    }

    const [patient, lead] = await Promise.all([
      conversation?.patientId
        ? tx.patient.findFirst({ where: { id: conversation.patientId, tenantId }, select: { id: true, fullName: true, language: true } })
        : tx.patient.findFirst({ where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] }, select: { id: true, fullName: true, language: true } }),
      conversation?.leadId
        ? tx.lead.findFirst({ where: { id: conversation.leadId, tenantId }, select: { id: true, fullName: true } })
        : tx.lead.findFirst({ where: { tenantId, ...notDeleted, OR: [{ phone }, { whatsapp: phone }] }, orderBy: { createdAt: "desc" }, select: { id: true, fullName: true } }),
    ]);

    let createdConversation = false;
    if (!conversation) {
      conversation = await tx.conversation.create({
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

    const message = await tx.message.create({
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

    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        lastInboundAt: now,
        status: "WAITING_ON_CLINIC",
        closedAt: null,
        objections,
        patientId: conversation.patientId ?? patient?.id ?? null,
        leadId: conversation.leadId ?? lead?.id ?? null,
        contactName: conversation.contactName ?? msg.name ?? null,
        contactPhone: conversation.contactPhone ?? phone,
        externalId: conversation.externalId ?? msg.conversationExternalId ?? null,
        updatedAt: now,
      },
    });
    return { duplicate: false as const, conversation: updated, messageId: message.id, patient, lead, createdConversation, objections };
  });

  if (stored.duplicate) return stored.result;
  const { conversation, messageId, patient, lead, createdConversation, objections } = stored;

  // Unknown contact: a lead opens itself so nobody falls through the cracks.
  let leadId = conversation.leadId;
  let createdLead = false;
  if (!leadId && !conversation.patientId) {
    const campaign = msg.ref ? await db.campaign.findFirst({ where: { tenantId, externalId: msg.ref }, select: { id: true, source: true } }) : null;
    // Attribution stays honest: a WhatsApp message counts as the ad only when it carries
    // the ad's referral; without one the desk sets the real source when they learn it.
    const source: LeadSourceKey = campaign?.source ?? (msg.channel === "WHATSAPP" ? (msg.ref ? "CLICK_TO_WHATSAPP_AD" : "OTHER") : channelToSource(msg.channel));
    const created = await createLead(
      tenantId,
      {
        fullName: msg.name?.trim() || phone,
        phone,
        source,
        campaignId: campaign?.id,
        conversationId: conversation.id,
        notes: `Opened from an inbound ${msg.channel === "WHATSAPP" ? "WhatsApp" : msg.channel.toLowerCase().replace("_", " ")} message${msg.channel === "WHATSAPP" && !msg.ref ? " (no ad referral)" : ""}.`,
      },
      {},
      { via: "webhook" },
    );
    leadId = created.id;
    createdLead = true;
  }

  // Awaited so the desk is told before the webhook is answered; a failure is logged, never fatal.
  const displayName = patient?.fullName ?? lead?.fullName ?? msg.name ?? phone;
  try {
    await notify(tenantId, {
      kind: "MESSAGE_INBOUND",
      title: `New message from ${displayName}`,
      body: msg.body.length > 140 ? `${msg.body.slice(0, 137)}…` : msg.body,
      href: `/dashboard/conversations?c=${conversation.id}`,
      entity: "Conversation",
      entityId: conversation.id,
      userIds: conversation.assignedToId ? [conversation.assignedToId] : [],
      roles: conversation.assignedToId ? [] : ["RECEPTIONIST"],
    });
  } catch (err) {
    console.error("[messaging] MESSAGE_INBOUND notification failed", err);
  }

  try {
    await db.channelIntegration.updateMany({ where: { tenantId, channel: msg.channel }, data: { lastInboundAt: now } });
  } catch (err) {
    console.error("[messaging] could not stamp lastInboundAt", err);
  }

  if (createdConversation) {
    await audit({
      tenantId,
      action: "conversation.inbound.open",
      entity: "Conversation",
      entityId: conversation.id,
      after: { channel: msg.channel, contactPhone: phone, patientId: conversation.patientId, leadId },
    });
  }

  return {
    conversationId: conversation.id,
    messageId,
    leadId,
    patientId: conversation.patientId,
    createdConversation,
    createdLead,
    duplicate: false,
    objections,
  };
}

// ── Delivery receipts ────────────────────────────────────────────────────────

export type ReceiptStatus = "SENT" | "DELIVERED" | "READ" | "FAILED";

/** A provider's word on one outbound message: WhatsApp's `statuses[]`, or the inbox webhook's `message.status`. */
export interface DeliveryReceipt {
  /** Our message id (the inbox webhook echoes the `messageId` it was sent). */
  messageId?: string | null;
  /** The provider's id for the message (WhatsApp's wamid). */
  externalId?: string | null;
  status: ReceiptStatus;
  at?: Date | null;
  reason?: string | null;
}

const RECEIPT_STATUS: Record<string, ReceiptStatus> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/** `statuses[]` inside a Meta webhook delivery (`entry[].changes[].value.statuses[]`). */
export function parseMetaStatuses(payload: unknown): DeliveryReceipt[] {
  const out: DeliveryReceipt[] = [];
  const root = payload as { entry?: unknown } | null;
  const entries = Array.isArray(root?.entry) ? root!.entry : [];
  for (const entry of entries as { changes?: unknown }[]) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes as { value?: Record<string, unknown> }[]) {
      const statuses = Array.isArray(change?.value?.statuses) ? (change.value.statuses as Record<string, unknown>[]) : [];
      for (const s of statuses) {
        const status = typeof s.status === "string" ? RECEIPT_STATUS[s.status] : undefined;
        if (!status || typeof s.id !== "string") continue;
        const ts = typeof s.timestamp === "string" ? Number(s.timestamp) * 1000 : NaN;
        const error = Array.isArray(s.errors) ? (s.errors[0] as { title?: string; message?: string; code?: number } | undefined) : undefined;
        out.push({
          externalId: s.id,
          status,
          at: Number.isFinite(ts) ? new Date(ts) : null,
          reason: error ? [error.code, error.title ?? error.message].filter(Boolean).join(" ").slice(0, 300) || null : null,
        });
      }
    }
  }
  return out;
}

/** `{ event: "message.status", messageId | externalId, status, reason?, at? }` from the clinic's inbox webhook. */
export const ReceiptPayload = z
  .object({
    event: z.literal("message.status"),
    messageId: zOptionalText(64),
    externalId: zOptionalText(160),
    status: z.enum(["sent", "delivered", "read", "failed"]),
    reason: zOptionalText(300),
    at: zOptionalText(40),
  })
  .refine((v) => Boolean(v.messageId || v.externalId), { message: "messageId or externalId is required", path: ["messageId"] })
  .transform(
    (v): DeliveryReceipt => ({
      messageId: v.messageId ?? null,
      externalId: v.externalId ?? null,
      status: RECEIPT_STATUS[v.status]!,
      reason: v.reason ?? null,
      at: v.at && !Number.isNaN(Date.parse(v.at)) ? new Date(v.at) : null,
    }),
  );

export function isReceiptPayload(json: unknown): boolean {
  return Boolean(json) && typeof json === "object" && !Array.isArray(json) && (json as { event?: unknown }).event === "message.status";
}

/** Receipts only move a message forward: a late "delivered" never undoes "read", "failed" never follows "delivered". */
const RECEIPT_RANK: Record<string, number> = { QUEUED: 0, LOGGED: 0, SENT: 1, FAILED: 1.5, DELIVERED: 2, READ: 3 };

export function receiptAdvances(current: string, next: ReceiptStatus): boolean {
  return (RECEIPT_RANK[next] ?? 0) > (RECEIPT_RANK[current] ?? 0);
}

/** Apply receipts to the tenant's outbound messages; returns how many changed. Unknown ids are ignored. */
export async function applyDeliveryReceipts(tenantId: string, receipts: readonly DeliveryReceipt[]): Promise<number> {
  let applied = 0;
  for (const receipt of receipts) {
    const id = receipt.messageId ?? null;
    const externalId = receipt.externalId ?? null;
    if (!id && !externalId) continue;
    const message = await db.message.findFirst({
      where: { tenantId, direction: "OUTBOUND", ...(id ? { id } : { externalId }) },
      select: { id: true, delivery: true, deliveredAt: true },
    });
    if (!message || !receiptAdvances(message.delivery, receipt.status)) continue;
    const at = receipt.at ?? new Date();
    await db.message.update({
      where: { id: message.id },
      data: {
        delivery: receipt.status,
        ...(receipt.status === "DELIVERED" || receipt.status === "READ" ? { deliveredAt: message.deliveredAt ?? at, failedReason: null } : {}),
        ...(receipt.status === "FAILED" ? { failedReason: receipt.reason ?? "The provider reported a failure" } : {}),
        ...(externalId && id ? { externalId } : {}),
      },
    });
    applied += 1;
  }
  return applied;
}
