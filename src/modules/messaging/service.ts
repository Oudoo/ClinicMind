import type { ChannelType, ObjectionTag, Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError, requireTenantPatient, requireTenantUser } from "@/lib/tenant-scope";
import { zText } from "@/lib/validation";
import { CHANNELS, OBJECTION_TAGS } from "@/modules/crm/shared";
import {
  CONVERSATION_STATUSES,
  INBOX_FILTERS,
  type ConversationRowDTO,
  type ConversationThreadDTO,
  type DeliveryModeKey,
  type InboxCountsDTO,
  type MessageDTO,
} from "./dto";
import { sendPatientMessage } from "./outbound";
import { unfilledPlaceholders } from "./placeholders";
import { getIntegration, isProvider } from "./provider";
import { templateContext } from "./templates";

/**
 * The reception inbox: threads with their status, assignment and objection
 * tags, the messages of a thread, replies (through `sendPatientMessage`) and
 * read receipts. Every query is tenant-scoped; every linked id (staff,
 * patient, lead) is proven to belong to the tenant; every change is audited.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const zId = zText(64).min(1);
const clearable = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

export const ConversationListQuery = z.object({
  status: z.preprocess(blankToUndefined, z.enum(INBOX_FILTERS).default("open")),
  channel: z.preprocess(blankToUndefined, z.enum(CHANNELS).optional()),
  mine: z.preprocess(blankToUndefined, z.enum(["1", "0"]).optional()),
  q: z.preprocess(blankToUndefined, zText(100).optional()),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(30)),
});
export type ConversationListFilter = z.infer<typeof ConversationListQuery>;

export const ReplyInput = z.object({
  body: zText(4000)
    .min(1, "Write a message first")
    .superRefine((body, ctx) => {
      // A patient must never receive "{{date}}": the receptionist fills what the template could not.
      const left = unfilledPlaceholders(body);
      if (left.length) ctx.addIssue({ code: "custom", message: `Replace ${left.map((p) => `{{${p}}}`).join(", ")} before sending` });
    }),
  /** The template the reply started from; blank or null means none. */
  templateKey: z.preprocess((v) => (v === null ? undefined : blankToUndefined(v)), zText(80).optional()),
});

export const ConversationPatchInput = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  assignedToId: clearable(zId),
  patientId: clearable(zId),
  leadId: clearable(zId),
  objections: z
    .array(z.enum(OBJECTION_TAGS))
    .max(6)
    .transform((xs) => [...new Set(xs)])
    .optional(),
  contactName: clearable(zText(120)),
});

// ── Shapes ───────────────────────────────────────────────────────────────────

const rowInclude = {
  patient: { select: { id: true, fullName: true } },
  lead: { select: { id: true, fullName: true, stage: true } },
  messages: { orderBy: { createdAt: "desc" as const }, take: 1, select: { body: true, direction: true, author: true, createdAt: true } },
} as const;
type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof rowInclude }>;

async function userNames(tenantId: string, ids: readonly (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, { id: string; fullName: string }>();
  const users = await db.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName ?? u.email }]));
}

function displayNameOf(row: { patient: { fullName: string } | null; lead: { fullName: string } | null; contactName: string | null; contactPhone: string | null }): string {
  return row.patient?.fullName ?? row.lead?.fullName ?? row.contactName ?? row.contactPhone ?? "Unknown contact";
}

function toRow(row: ConversationRow, unread: number, staff: Map<string, { id: string; fullName: string }>): ConversationRowDTO {
  const last = row.messages[0];
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    locale: row.locale,
    displayName: displayNameOf(row),
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    patient: row.patient,
    lead: row.lead,
    assignedTo: row.assignedToId ? (staff.get(row.assignedToId) ?? null) : null,
    lastMessage: last ? { body: last.body, direction: last.direction, author: last.author, createdAt: last.createdAt.toISOString() } : null,
    unread,
    objections: row.objections,
    objectionsConfirmedAt: row.objectionsConfirmedAt?.toISOString() ?? null,
    summary: row.summary,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function unreadCounts(tenantId: string, conversationIds: string[]): Promise<Map<string, number>> {
  if (!conversationIds.length) return new Map();
  const groups = await db.message.groupBy({
    by: ["conversationId"],
    where: { tenantId, conversationId: { in: conversationIds }, direction: "INBOUND", readAt: null },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [g.conversationId, g._count._all]));
}

// ── Reads ────────────────────────────────────────────────────────────────────

function statusWhere(filter: ConversationListFilter["status"]): Prisma.ConversationWhereInput {
  switch (filter) {
    case "open":
      return { status: { not: "CLOSED" } };
    case "waiting_clinic":
      return { status: "WAITING_ON_CLINIC" };
    case "waiting_patient":
      return { status: "WAITING_ON_PATIENT" };
    case "closed":
      return { status: "CLOSED" };
    default:
      return {};
  }
}

export async function listConversations(tenantId: string, filter: ConversationListFilter, userId: string | null) {
  const search: Prisma.ConversationWhereInput[] = [];
  const q = filter.q?.trim();
  if (q) {
    search.push(
      { contactName: { contains: q, mode: "insensitive" } },
      { patient: { fullName: { contains: q, mode: "insensitive" } } },
      { lead: { fullName: { contains: q, mode: "insensitive" } } },
    );
    const digits = q.replace(/[\s()+\-.]/g, "");
    if (/^\d{3,}$/.test(digits)) search.push({ contactPhone: { contains: digits } }, { patient: { phone: { contains: digits } } });
  }
  const where: Prisma.ConversationWhereInput = {
    tenantId,
    ...statusWhere(filter.status),
    ...(filter.channel ? { channel: filter.channel } : {}),
    ...(filter.mine === "1" ? { assignedToId: userId ?? "-" } : {}),
    ...(search.length ? { OR: search } : {}),
  };
  const skip = (filter.page - 1) * filter.pageSize;
  const [rows, total] = await db.$transaction([
    db.conversation.findMany({ where, orderBy: { updatedAt: "desc" }, skip, take: filter.pageSize, include: rowInclude }),
    db.conversation.count({ where }),
  ]);
  const [unread, staff, counts] = await Promise.all([
    unreadCounts(tenantId, rows.map((r) => r.id)),
    userNames(tenantId, rows.map((r) => r.assignedToId)),
    inboxCounts(tenantId),
  ]);
  return {
    conversations: rows.map((r) => toRow(r, unread.get(r.id) ?? 0, staff)),
    total,
    page: filter.page,
    pageSize: filter.pageSize,
    counts,
  };
}

export async function inboxCounts(tenantId: string): Promise<InboxCountsDTO> {
  const [open, waitingClinic, waitingPatient, closed, unread] = await db.$transaction([
    db.conversation.count({ where: { tenantId, status: { not: "CLOSED" } } }),
    db.conversation.count({ where: { tenantId, status: "WAITING_ON_CLINIC" } }),
    db.conversation.count({ where: { tenantId, status: "WAITING_ON_PATIENT" } }),
    db.conversation.count({ where: { tenantId, status: "CLOSED" } }),
    db.message.count({ where: { tenantId, direction: "INBOUND", readAt: null, conversation: { status: { not: "CLOSED" } } } }),
  ]);
  return { open, waitingClinic, waitingPatient, closed, unread };
}

export const MAX_THREAD_MESSAGES = 300;

/** How replies on `channel` are delivered for the tenant right now (see provider.ts). */
export async function deliveryModeFor(tenantId: string, channel: ChannelType): Promise<DeliveryModeKey> {
  const integration = await getIntegration(tenantId, channel).catch(() => null);
  if (!integration?.enabled || !isProvider(integration.provider) || integration.provider === "manual") return "logged";
  return integration.provider;
}

export async function getConversation(tenantId: string, id: string): Promise<ConversationThreadDTO | null> {
  const row = await db.conversation.findFirst({ where: { id, tenantId }, include: rowInclude });
  if (!row) return null;
  // The latest messages, oldest first: a long thread shows its newest part, not its first 300 lines.
  const latest = await db.message.findMany({
    where: { tenantId, conversationId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_THREAD_MESSAGES + 1,
  });
  const truncated = latest.length > MAX_THREAD_MESSAGES;
  const messages = latest.slice(0, MAX_THREAD_MESSAGES).reverse();
  const [staff, vars, deliveryMode, unread] = await Promise.all([
    userNames(tenantId, [row.assignedToId, ...messages.map((m) => m.authorId)]),
    templateContext(tenantId, id),
    deliveryModeFor(tenantId, row.channel),
    db.message.count({ where: { tenantId, conversationId: id, direction: "INBOUND", readAt: null } }),
  ]);
  const dto: MessageDTO[] = messages.map((m) => ({
    id: m.id,
    direction: m.direction,
    body: m.body,
    author: m.author,
    authorName: m.authorId ? (staff.get(m.authorId)?.fullName ?? null) : null,
    delivery: m.delivery,
    externalId: m.externalId,
    templateKey: m.templateKey,
    failedReason: m.failedReason,
    readAt: m.readAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));
  return { ...toRow(row, unread, staff), messages: dto, truncated, templateContext: vars, deliveryMode };
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function requireConversation(tenantId: string, id: string) {
  const row = await db.conversation.findFirst({ where: { id, tenantId } });
  if (!row) throw new TenantScopeError("conversation", id);
  return row;
}

/** A staff reply: stored as HUMAN by the acting user and delivered through the channel. */
export async function replyToConversation(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ReplyInput.parse(rawInput);
  const conversation = await requireConversation(tenantId, id);
  const result = await sendPatientMessage(tenantId, {
    conversationId: conversation.id,
    patientId: conversation.patientId,
    phone: conversation.contactPhone,
    channel: conversation.channel,
    body: input.body,
    templateKey: input.templateKey ?? null,
    authorId: actor.id ?? null,
    author: "HUMAN",
  });
  const message = await db.message.findFirstOrThrow({ where: { id: result.messageId, tenantId } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "conversation.reply",
    entity: "Conversation",
    entityId: id,
    after: { messageId: message.id, delivery: message.delivery, templateKey: input.templateKey ?? null, length: input.body.length },
  });
  const staff = await userNames(tenantId, [message.authorId]);
  const dto: MessageDTO = {
    id: message.id,
    direction: message.direction,
    body: message.body,
    author: message.author,
    authorName: message.authorId ? (staff.get(message.authorId)?.fullName ?? null) : null,
    delivery: message.delivery,
    externalId: message.externalId,
    templateKey: message.templateKey,
    failedReason: message.failedReason,
    readAt: null,
    createdAt: message.createdAt.toISOString(),
  };
  return { message: dto, delivery: message.delivery, failedReason: message.failedReason };
}

/** Status, assignment, links to a patient or lead, confirmed objections, contact name. */
export async function patchConversation(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ConversationPatchInput.parse(rawInput);
  const before = await requireConversation(tenantId, id);
  if (input.assignedToId) await requireTenantUser(tenantId, input.assignedToId);
  if (input.patientId) await requireTenantPatient(tenantId, input.patientId);
  if (input.leadId) {
    const lead = await db.lead.findFirst({ where: { id: input.leadId, tenantId, ...notDeleted }, select: { id: true } });
    if (!lead) throw new TenantScopeError("lead", input.leadId);
  }
  const now = new Date();
  const data: Prisma.ConversationUpdateInput = {};
  if (input.status !== undefined) {
    data.status = input.status;
    data.closedAt = input.status === "CLOSED" ? now : null;
  }
  if (input.assignedToId !== undefined) data.assignedToId = input.assignedToId;
  if (input.patientId !== undefined) data.patient = input.patientId ? { connect: { id: input.patientId } } : { disconnect: true };
  if (input.leadId !== undefined) data.lead = input.leadId ? { connect: { id: input.leadId } } : { disconnect: true };
  if (input.contactName !== undefined) data.contactName = input.contactName;
  if (input.objections !== undefined) {
    data.objections = input.objections as ObjectionTag[];
    data.objectionsConfirmedAt = now;
  }

  const after = await db.$transaction(async (tx) => {
    const row = await tx.conversation.update({ where: { id, tenantId }, data });
    // Confirmed objections belong to the lead too, where the lost-reason reports read them.
    const leadId = input.leadId !== undefined ? input.leadId : before.leadId;
    if (input.objections !== undefined && leadId) {
      await tx.lead.updateMany({ where: { id: leadId, tenantId }, data: { objections: input.objections as ObjectionTag[] } });
    }
    return row;
  });

  // Closing and reopening a thread are named in the audit log; other edits are updates.
  const action =
    before.status !== after.status && after.status === "CLOSED"
      ? "conversation.close"
      : before.status === "CLOSED" && after.status !== "CLOSED"
        ? "conversation.reopen"
        : "conversation.update";
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action,
    entity: "Conversation",
    entityId: id,
    before: { status: before.status, assignedToId: before.assignedToId, patientId: before.patientId, leadId: before.leadId, objections: before.objections, contactName: before.contactName },
    after: { status: after.status, assignedToId: after.assignedToId, patientId: after.patientId, leadId: after.leadId, objections: after.objections, contactName: after.contactName },
  });
  return getConversation(tenantId, id);
}

/** Read receipts: every unread inbound message of the thread is stamped now. */
export async function markConversationRead(tenantId: string, id: string, actor: Actor = {}) {
  await requireConversation(tenantId, id);
  const result = await db.message.updateMany({ where: { tenantId, conversationId: id, direction: "INBOUND", readAt: null }, data: { readAt: new Date() } });
  if (result.count) {
    await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "conversation.read", entity: "Conversation", entityId: id, after: { marked: result.count } });
  }
  return { marked: result.count };
}
