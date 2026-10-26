import { Prisma, type LeadStage, type ObjectionTag } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError, requireTenantPatient, requireTenantUser } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { endOfDayInTz, formatDateInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { listTreatments, requireTenantTreatment } from "@/modules/treatments/service";
import { createAppointment, getTenantTimezone } from "@/modules/appointments/service";
import { notify } from "@/modules/notifications/service";
import type { BoardColumnDTO, CampaignDTO, CostImportPreviewDTO, FollowUpDTO, LeadCardDTO } from "./dto";
import {
  CAMPAIGN_PLATFORMS,
  CHANNELS,
  CONSULTATION_STAGES,
  FOLLOW_UP_SCOPES,
  LEAD_SORTS,
  LEAD_SOURCES,
  LEAD_STAGES,
  LOST_REASONS,
  OBJECTION_TAGS,
  SOURCE_LABELS,
  canMoveStage,
  normalisePhone,
  sourceToChannel,
  stageIndex,
  type LeadStageKey,
} from "./shared";

/**
 * CRM: leads, the pipeline, follow-ups and ads campaigns with their costs.
 * Every query is scoped by `tenantId`; every client-supplied id (campaign,
 * owner, patient, treatment key, conversation) is proven to belong to the
 * tenant before it is stored (SEC-4); every mutation is audited.
 */

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

type Client = Prisma.TransactionClient;

// ── Errors (mapped to HTTP by the route layer) ───────────────────────────────

/** 409: the move is not allowed by the pipeline rules. */
export class LeadStageError extends Error {
  readonly status = 409;
  readonly code = "invalid_stage";
  constructor(
    readonly from: LeadStage,
    readonly to: LeadStage,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "LeadStageError";
  }
}

/** 409: the lead (or follow-up) is not in a state where this action applies. */
export class LeadStateError extends Error {
  readonly status = 409;
  constructor(
    readonly code: "already_lost" | "not_lost" | "already_converted" | "follow_up_done" | "lead_lost" | "duplicate_external_id",
    message: string,
  ) {
    super(message);
    this.name = "LeadStateError";
  }
}

/** 422 with field errors in the shape of a Zod failure, for checks Zod cannot make (treatment keys, CSV rows). */
export class CrmValidationError extends Error {
  readonly status = 422;
  constructor(readonly fieldErrors: Record<string, string[]>) {
    super(Object.values(fieldErrors)[0]?.[0] ?? "Invalid input");
    this.name = "CrmValidationError";
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const zId = zText(64).min(1);
const zOptId = z.preprocess(blankToUndefined, zId.optional());
/** On an update a blank or null clears the column; absent keeps it. */
const clearable = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

export const zLeadPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()\-.]{7,20}$/, "Invalid phone number")
  .transform(normalisePhone);
const zEmail = z.string().trim().toLowerCase().max(254).email("Invalid e-mail address");
const zInterests = z.array(zText(60).min(1)).max(10).transform((xs) => [...new Set(xs)]);
const zObjections = z.array(z.enum(OBJECTION_TAGS)).max(6).transform((xs) => [...new Set(xs)]);
const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const LeadInput = z.object({
  fullName: zText(120).min(1, "Name is required"),
  phone: z.preprocess(blankToUndefined, zLeadPhone.optional()),
  whatsapp: z.preprocess(blankToUndefined, zLeadPhone.optional()),
  email: z.preprocess(blankToUndefined, zEmail.optional()),
  source: z.enum(LEAD_SOURCES).default("OTHER"),
  campaignId: zOptId,
  interests: zInterests.default([]),
  ownerId: zOptId,
  notes: zOptionalText(4000),
  /** An inbox thread to link to the new lead ("Create lead from this thread"). */
  conversationId: zOptId,
  /** Walk-ins and phone enquiries may start further along than NEW. */
  stage: z.enum(["NEW", "CONTACTED", "QUALIFIED"]).default("NEW"),
});
export type LeadInput = z.input<typeof LeadInput>;

export const LeadUpdateInput = z.object({
  fullName: zText(120).min(1).optional(),
  phone: clearable(zLeadPhone),
  whatsapp: clearable(zLeadPhone),
  email: clearable(zEmail),
  source: z.enum(LEAD_SOURCES).optional(),
  campaignId: clearable(zId),
  interests: zInterests.optional(),
  ownerId: clearable(zId),
  notes: clearable(zText(4000)),
});
export type LeadUpdateInput = z.input<typeof LeadUpdateInput>;

const zq = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToUndefined, schema.optional());

/** Query string of GET /api/leads. `from`/`to` are calendar days on the clinic clock. */
export const LeadListQuery = z.object({
  q: zq(zText(100)),
  stage: zq(z.enum(LEAD_STAGES)),
  source: zq(z.enum(LEAD_SOURCES)),
  ownerId: zq(zId),
  interest: zq(zText(60)),
  campaignId: zq(zId),
  from: zq(zDateKey),
  to: zq(zDateKey),
  sort: z.preprocess(blankToUndefined, z.enum(LEAD_SORTS).default("newest")),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).default(1)),
  pageSize: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100).default(25)),
});
export type LeadListFilter = z.infer<typeof LeadListQuery>;

export const StageInput = z.object({ stage: z.enum(LEAD_STAGES) });

export const LostInput = z.object({
  reason: z.enum(LOST_REASONS),
  note: zOptionalText(1000),
  objections: zObjections.default([]),
});

export const ConvertInput = z.object({
  /** Link this existing patient instead of creating one. */
  patientId: zOptId,
  referredBy: zOptionalText(120),
  language: z.enum(["ar", "en"]).default("ar"),
});

const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

export const BookConsultationInput = z
  .object({
    doctorId: zId,
    startsAt: zDateTime,
    endsAt: zDateTime,
    room: zOptionalText(60),
    reason: zOptionalText(300),
    allowWaitlist: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!isDate(v.startsAt) || !isDate(v.endsAt)) return;
    if (v.endsAt.getTime() <= v.startsAt.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "End must be after start" });
    }
  });

export const FollowUpInput = z.object({
  dueAt: zDateTime,
  note: zOptionalText(1000),
  channel: zq(z.enum(CHANNELS)),
  ownerId: zOptId,
});

export const FollowUpCompleteInput = z.object({ outcome: zText(1000).min(1, "Say what happened") });

export const FollowUpListQuery = z.object({ scope: z.preprocess(blankToUndefined, z.enum(FOLLOW_UP_SCOPES).default("due")) });

const zMoney = z.coerce.number().int().min(0).max(100_000_000);

export const CampaignInput = z.object({
  externalId: zText(120).min(1, "The platform's campaign id is required"),
  name: zText(160).min(1, "Name is required"),
  platform: z.enum(CAMPAIGN_PLATFORMS),
  source: z.enum(LEAD_SOURCES).default("CLICK_TO_WHATSAPP_AD"),
  treatmentId: zOptId,
  active: z.boolean().default(true),
  startedAt: zq(zDateKey),
  endedAt: zq(zDateKey),
});
export type CampaignInput = z.input<typeof CampaignInput>;

export const CampaignUpdateInput = z.object({
  externalId: zText(120).min(1).optional(),
  name: zText(160).min(1).optional(),
  platform: z.enum(CAMPAIGN_PLATFORMS).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  treatmentId: clearable(zId),
  active: z.boolean().optional(),
  startedAt: clearable(zDateKey),
  endedAt: clearable(zDateKey),
});

export const CampaignCostInput = z
  .object({ periodStart: zDateKey, periodEnd: zDateKey, amount: zMoney })
  .superRefine((v, ctx) => {
    if (v.periodEnd < v.periodStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["periodEnd"], message: "Period end must not be before its start" });
    }
  });

export const CostImportInput = z.object({
  csv: z.string().max(200_000),
  /** false (default) previews; true writes the rows. */
  commit: z.boolean().default(false),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const campaignRef = { select: { id: true, name: true, platform: true } } as const;
const patientRef = { select: { id: true, fullName: true, phone: true } } as const;
const nextFollowUp = { where: { doneAt: null }, orderBy: { dueAt: "asc" as const }, take: 1, select: { id: true, dueAt: true } };

const leadListInclude = { campaign: campaignRef, patient: patientRef, followUps: nextFollowUp } as const;
type LeadListRow = Prisma.LeadGetPayload<{ include: typeof leadListInclude }>;

async function userNames(tenantId: string, ids: readonly (string | null | undefined)[], client: Client = db) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, { id: string; fullName: string }>();
  const users = await client.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName ?? u.email }]));
}

function toCard(row: LeadListRow, owners: Map<string, { id: string; fullName: string }>): LeadCardDTO {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    stage: row.stage,
    source: row.source,
    interests: row.interests,
    campaign: row.campaign ? { id: row.campaign.id, name: row.campaign.name, platform: row.campaign.platform } : null,
    owner: row.ownerId ? (owners.get(row.ownerId) ?? null) : null,
    patientId: row.patientId,
    createdAt: row.createdAt.toISOString(),
    lastContactAt: row.lastContactAt?.toISOString() ?? null,
    nextFollowUpAt: row.followUps[0]?.dueAt.toISOString() ?? null,
    lostReason: row.lostReason,
    wonAt: row.wonAt?.toISOString() ?? null,
    objections: row.objections,
  };
}

async function requireLead(tenantId: string, id: string, client: Client = db) {
  const lead = await client.lead.findFirst({ where: { id, tenantId, ...notDeleted } });
  if (!lead) throw new TenantScopeError("lead", id);
  return lead;
}

async function requireCampaign(tenantId: string, id: string, client: Client = db) {
  const campaign = await client.campaign.findFirst({ where: { id, tenantId }, select: { id: true, name: true } });
  if (!campaign) throw new TenantScopeError("campaign", id);
  return campaign;
}

async function requireConversation(tenantId: string, id: string, client: Client = db) {
  const row = await client.conversation.findFirst({ where: { id, tenantId }, select: { id: true, leadId: true } });
  if (!row) throw new TenantScopeError("conversation", id);
  return row;
}

/** Interests are treatment keys of the tenant; anything else is a 422 on `interests`. */
async function checkInterests(tenantId: string, interests: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
  const treatments = await listTreatments(tenantId);
  const byKey = new Map(treatments.map((t) => [t.key, { id: t.id, name: t.name }]));
  const unknown = interests.filter((k) => !byKey.has(k));
  if (unknown.length) throw new CrmValidationError({ interests: [`Unknown treatment: ${unknown.join(", ")}`] });
  return byKey;
}

/** JSON-safe audit snapshot. */
function leadSnapshot(lead: {
  fullName: string;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  source: string;
  campaignId: string | null;
  interests: string[];
  stage: string;
  ownerId: string | null;
  patientId: string | null;
  notes: string | null;
  lostReason: string | null;
  lostAtStage: string | null;
  objections: string[];
}) {
  return {
    fullName: lead.fullName,
    phone: lead.phone,
    whatsapp: lead.whatsapp,
    email: lead.email,
    source: lead.source,
    campaignId: lead.campaignId,
    interests: lead.interests,
    stage: lead.stage,
    ownerId: lead.ownerId,
    patientId: lead.patientId,
    notes: lead.notes,
    lostReason: lead.lostReason,
    lostAtStage: lead.lostAtStage,
    objections: lead.objections,
  };
}

function definedEntries<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ── Leads: reads ─────────────────────────────────────────────────────────────

async function leadWhere(tenantId: string, f: LeadListFilter): Promise<Prisma.LeadWhereInput> {
  const search: Prisma.LeadWhereInput[] = [];
  const q = f.q?.trim();
  if (q) {
    // `contains` on fullName is served by the trigram index (leads_fullName_trgm_idx).
    search.push({ fullName: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } });
    const digits = q.replace(/[\s()+\-.]/g, "");
    if (/^\d{3,}$/.test(digits)) search.push({ phone: { contains: digits } }, { whatsapp: { contains: digits } });
  }
  let createdAt: Prisma.DateTimeFilter | undefined;
  if (f.from || f.to) {
    const tz = await getTenantTimezone(tenantId);
    const from = f.from ? fromDateKey(f.from, tz) : null;
    const to = f.to ? fromDateKey(f.to, tz) : null;
    createdAt = {
      ...(from ? { gte: startOfDayInTz(from, tz) } : {}),
      ...(to ? { lte: endOfDayInTz(to, tz) } : {}),
    };
  }
  return {
    tenantId,
    ...notDeleted,
    ...(f.stage ? { stage: f.stage } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.ownerId ? { ownerId: f.ownerId } : {}),
    ...(f.interest ? { interests: { has: f.interest } } : {}),
    ...(f.campaignId ? { campaignId: f.campaignId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(search.length ? { OR: search } : {}),
  };
}

function leadOrder(sort: LeadListFilter["sort"]): Prisma.LeadOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "lastContact":
      return [{ lastContactAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

export async function listLeads(tenantId: string, filter: LeadListFilter) {
  const where = await leadWhere(tenantId, filter);
  const skip = (filter.page - 1) * filter.pageSize;
  const [rows, total] = await db.$transaction([
    db.lead.findMany({ where, orderBy: leadOrder(filter.sort), skip, take: filter.pageSize, include: leadListInclude }),
    db.lead.count({ where }),
  ]);
  const owners = await userNames(tenantId, rows.map((r) => r.ownerId));
  return { leads: rows.map((r) => toCard(r, owners)), total, page: filter.page, pageSize: filter.pageSize };
}

export const BOARD_COLUMN_SIZE = 40;

/** One column per stage with its first cards (newest first) and the full count. */
export async function boardLeads(tenantId: string, filter: LeadListFilter): Promise<BoardColumnDTO[]> {
  const base = await leadWhere(tenantId, { ...filter, stage: undefined });
  const stages = filter.stage ? [filter.stage] : [...LEAD_STAGES];
  const [counts, perStage] = await Promise.all([
    db.lead.groupBy({ by: ["stage"], where: base, _count: { _all: true } }),
    db.$transaction(
      stages.map((stage) =>
        db.lead.findMany({ where: { ...base, stage }, orderBy: leadOrder(filter.sort), take: BOARD_COLUMN_SIZE, include: leadListInclude }),
      ),
    ),
  ]);
  const rows = perStage.flat();
  const owners = await userNames(tenantId, rows.map((r) => r.ownerId));
  const countOf = new Map(counts.map((c) => [c.stage, c._count._all]));
  return stages.map((stage, i) => ({ stage, total: countOf.get(stage) ?? 0, leads: (perStage[i] ?? []).map((r) => toCard(r, owners)) }));
}

export async function getLead(tenantId: string, id: string) {
  const lead = await db.lead.findFirst({
    where: { id, tenantId, ...notDeleted },
    include: {
      campaign: campaignRef,
      patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, email: true, source: true } },
      followUps: { orderBy: [{ doneAt: "asc" }, { dueAt: "asc" }], take: 50 },
      conversations: {
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: {
          id: true,
          channel: true,
          status: true,
          lastInboundAt: true,
          lastOutboundAt: true,
          updatedAt: true,
          objections: true,
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, createdAt: true } },
          _count: { select: { messages: true } },
        },
      },
      escalations: { where: { status: { not: "RESOLVED" } }, orderBy: { createdAt: "desc" }, take: 5 },
    },
  });
  if (!lead) return null;
  const consultation = lead.consultationAppointmentId
    ? await db.appointment.findFirst({
        where: { id: lead.consultationAppointmentId, tenantId, ...notDeleted },
        select: { id: true, startsAt: true, endsAt: true, status: true, doctorId: true, room: true },
      })
    : null;
  const names = await userNames(tenantId, [
    lead.ownerId,
    consultation?.doctorId,
    ...lead.followUps.map((f) => f.ownerId),
    ...lead.followUps.map((f) => f.doneById),
  ]);
  const treatments = await listTreatments(tenantId);
  const treatmentName = new Map(treatments.map((t) => [t.key, t.name]));
  return {
    ...lead,
    owner: lead.ownerId ? (names.get(lead.ownerId) ?? null) : null,
    interestNames: lead.interests.map((k) => treatmentName.get(k) ?? k),
    consultation: consultation ? { ...consultation, doctor: consultation.doctorId ? (names.get(consultation.doctorId) ?? null) : null } : null,
    followUps: lead.followUps.map((f) => ({
      ...f,
      owner: f.ownerId ? (names.get(f.ownerId) ?? null) : null,
      doneBy: f.doneById ? (names.get(f.doneById) ?? null) : null,
    })),
  };
}

export type LeadDetail = NonNullable<Awaited<ReturnType<typeof getLead>>>;

// ── Leads: writes ────────────────────────────────────────────────────────────

export async function createLead(tenantId: string, rawInput: unknown, actor: Actor = {}, opts: { via?: "staff" | "webhook" } = {}) {
  const input = LeadInput.parse(rawInput);
  const treatments = await checkInterests(tenantId, input.interests);
  if (input.campaignId) await requireCampaign(tenantId, input.campaignId);
  if (input.ownerId) await requireTenantUser(tenantId, input.ownerId);
  if (input.conversationId) await requireConversation(tenantId, input.conversationId);

  const now = new Date();
  const lead = await db.$transaction(async (tx) => {
    const created = await tx.lead.create({
      data: {
        tenantId,
        fullName: input.fullName,
        phone: input.phone ?? null,
        whatsapp: input.whatsapp ?? input.phone ?? null,
        email: input.email ?? null,
        source: input.source,
        campaignId: input.campaignId ?? null,
        interests: input.interests,
        ownerId: input.ownerId ?? null,
        notes: input.notes ?? null,
        stage: input.stage,
        firstTouchAt: now,
        lastContactAt: input.stage === "NEW" ? null : now,
      },
      include: leadListInclude,
    });
    if (input.conversationId) {
      await tx.conversation.updateMany({ where: { id: input.conversationId, tenantId }, data: { leadId: created.id } });
      await tx.conversation.updateMany({ where: { id: input.conversationId, tenantId, contactName: null }, data: { contactName: input.fullName } });
    }
    return created;
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.create",
    entity: "Lead",
    entityId: lead.id,
    after: { ...leadSnapshot(lead), via: opts.via ?? "staff" },
  });

  const interestNames = input.interests.map((k) => treatments.get(k)?.name ?? k);
  notify(tenantId, {
    kind: "LEAD_NEW",
    title: `New lead: ${lead.fullName}`,
    body: [SOURCE_LABELS[lead.source], interestNames.join(", ")].filter(Boolean).join(" · "),
    href: `/dashboard/leads/${lead.id}`,
    entity: "Lead",
    entityId: lead.id,
    roles: ["RECEPTIONIST"],
    userIds: lead.ownerId ? [lead.ownerId] : [],
    excludeUserId: actor.id ?? null,
  }).catch((err) => console.error("[crm] LEAD_NEW notification failed", err));

  const owners = await userNames(tenantId, [lead.ownerId]);
  return toCard(lead, owners);
}

export async function updateLead(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const patch = definedEntries(LeadUpdateInput.parse(rawInput));
  const before = await requireLead(tenantId, id);
  if (patch.interests) await checkInterests(tenantId, patch.interests);
  if (patch.campaignId) await requireCampaign(tenantId, patch.campaignId);
  if (patch.ownerId) await requireTenantUser(tenantId, patch.ownerId);

  const after = await db.lead.update({ where: { id, tenantId }, data: patch, include: leadListInclude });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.update",
    entity: "Lead",
    entityId: id,
    before: leadSnapshot(before),
    after: leadSnapshot(after),
  });
  const owners = await userNames(tenantId, [after.ownerId]);
  return toCard(after, owners);
}

export async function changeStage(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const { stage } = StageInput.parse(rawInput);
  const before = await requireLead(tenantId, id);
  const move = canMoveStage(before.stage, stage);
  if (!move.ok) throw new LeadStageError(before.stage, stage, move.reason);
  const now = new Date();
  const after = await db.lead.update({
    where: { id, tenantId },
    data: { stage, lastContactAt: now, ...(stage === "WON" ? { wonAt: now } : {}) },
    include: leadListInclude,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.stage",
    entity: "Lead",
    entityId: id,
    before: { stage: before.stage },
    after: { stage: after.stage, wonAt: after.wonAt?.toISOString() ?? null },
  });
  const owners = await userNames(tenantId, [after.ownerId]);
  return toCard(after, owners);
}

export async function markLost(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = LostInput.parse(rawInput);
  const before = await requireLead(tenantId, id);
  if (before.stage === "LOST") throw new LeadStateError("already_lost", "The lead is already marked lost.");
  const now = new Date();
  const objections = [...new Set([...before.objections, ...input.objections])] as ObjectionTag[];
  const after = await db.$transaction(async (tx) => {
    const row = await tx.lead.update({
      where: { id, tenantId },
      data: {
        stage: "LOST",
        lostReason: input.reason,
        lostNote: input.note ?? null,
        lostAtStage: before.stage,
        lostAt: now,
        objections,
        lastContactAt: now,
      },
      include: leadListInclude,
    });
    // Nothing left to chase: open follow-ups close and their escalations resolve.
    await tx.leadFollowUp.updateMany({
      where: { tenantId, leadId: id, doneAt: null },
      data: { doneAt: now, doneById: actor.id ?? null, outcome: "Lead marked lost" },
    });
    await tx.escalation.updateMany({
      where: { tenantId, leadId: id, kind: "LEAD_FOLLOW_UP", status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now, resolvedById: actor.id ?? null, resolution: "Lead marked lost" },
    });
    return row;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.lost",
    entity: "Lead",
    entityId: id,
    before: { stage: before.stage, objections: before.objections },
    after: { stage: "LOST", lostReason: input.reason, lostNote: input.note ?? null, lostAtStage: before.stage, objections },
  });
  const owners = await userNames(tenantId, [after.ownerId]);
  return toCard(after, owners);
}

export async function reopenLead(tenantId: string, id: string, actor: Actor = {}) {
  const before = await requireLead(tenantId, id);
  if (before.stage !== "LOST") throw new LeadStateError("not_lost", "Only a lost lead can be reopened.");
  const stage: LeadStage = before.lostAtStage && before.lostAtStage !== "LOST" && before.lostAtStage !== "WON" ? before.lostAtStage : "NEW";
  const after = await db.lead.update({
    where: { id, tenantId },
    data: { stage, lostReason: null, lostNote: null, lostAtStage: null, lostAt: null, lastContactAt: new Date() },
    include: leadListInclude,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.reopen",
    entity: "Lead",
    entityId: id,
    before: { stage: "LOST", lostReason: before.lostReason, lostAtStage: before.lostAtStage },
    after: { stage },
  });
  const owners = await userNames(tenantId, [after.ownerId]);
  return toCard(after, owners);
}

/**
 * Create the patient record for a lead (or link an existing one), stamp the
 * patient's first-touch source and put "Came in as a lead" on the timeline.
 */
export async function convertLead(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ConvertInput.parse(rawInput ?? {});
  const lead = await requireLead(tenantId, id);
  if (lead.patientId) throw new LeadStateError("already_converted", "This lead is already linked to a patient.");
  if (input.patientId) await requireTenantPatient(tenantId, input.patientId);

  const { patient, created } = await db.$transaction(async (tx) => {
    let patientId = input.patientId ?? null;
    let created = false;
    if (!patientId) {
      const row = await tx.patient.create({
        data: {
          tenantId,
          fullName: lead.fullName,
          phone: lead.phone,
          whatsapp: lead.whatsapp ?? lead.phone,
          email: lead.email,
          language: input.language,
          tags: lead.interests,
          source: lead.source,
          referredBy: lead.source === "REFERRAL" ? (input.referredBy ?? "Referral") : (input.referredBy ?? null),
          notes: lead.notes ? `From lead: ${lead.notes}` : null,
          medicalHistory: { create: { tenantId } },
        },
        select: { id: true },
      });
      patientId = row.id;
      created = true;
    } else {
      // An existing patient keeps its own first-touch source unless it has none.
      await tx.patient.updateMany({ where: { id: patientId, tenantId, source: null }, data: { source: lead.source, referredBy: input.referredBy ?? undefined } });
    }
    await tx.lead.update({ where: { id, tenantId }, data: { patientId } });
    await tx.conversation.updateMany({ where: { tenantId, leadId: id, patientId: null }, data: { patientId } });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId,
        kind: "LEAD",
        title: `Came in as a lead (${SOURCE_LABELS[lead.source]})`,
        body: lead.interests.length ? `Interested in: ${lead.interests.join(", ")}` : null,
        refId: lead.id,
        occurredAt: lead.firstTouchAt,
      },
    });
    const patient = await tx.patient.findFirstOrThrow({ where: { id: patientId, tenantId }, select: { id: true, fullName: true, phone: true } });
    return { patient, created };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.convert",
    entity: "Lead",
    entityId: id,
    before: { patientId: null },
    after: { patientId: patient.id, created },
  });
  return { leadId: id, patient, created };
}

/**
 * Book the consultation through the appointments service (conflict detection,
 * timeline, audit) and move the lead to CONSULTATION_BOOKED. A lead without a
 * patient record gets one first, since appointments belong to patients.
 */
export async function bookConsultation(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = BookConsultationInput.parse(rawInput);
  let lead = await requireLead(tenantId, id);
  if (lead.stage === "LOST") throw new LeadStateError("lead_lost", "Reopen the lead before booking.");
  await requireTenantUser(tenantId, input.doctorId);

  if (!lead.patientId) {
    await convertLead(tenantId, id, {}, actor);
    lead = await requireLead(tenantId, id);
  }
  const treatments = await listTreatments(tenantId);
  const firstInterest = lead.interests[0];
  const treatment = firstInterest ? (treatments.find((t) => t.key === firstInterest) ?? null) : null;

  const { appointment } = await createAppointment(
    tenantId,
    {
      patientId: lead.patientId!,
      doctorId: input.doctorId,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      room: input.room,
      reason: input.reason ?? `Consultation${treatment ? ` — ${treatment.name}` : ""}`,
      notes: `Booked from lead ${lead.fullName}`,
      source: sourceToChannel(lead.source),
      allowWaitlist: input.allowWaitlist,
    },
    actor,
  );
  // The booking is a consultation that came from this lead (reports read both columns).
  await db.appointment.update({
    where: { id: appointment.id, tenantId },
    data: { kind: "CONSULTATION", leadId: lead.id, treatmentId: treatment?.id ?? null },
  });

  const now = new Date();
  const advance = stageIndex(lead.stage) < stageIndex("CONSULTATION_BOOKED");
  const after = await db.lead.update({
    where: { id, tenantId },
    data: { consultationAppointmentId: appointment.id, lastContactAt: now, ...(advance ? { stage: "CONSULTATION_BOOKED" } : {}) },
    include: leadListInclude,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.book",
    entity: "Lead",
    entityId: id,
    before: { stage: lead.stage, consultationAppointmentId: lead.consultationAppointmentId },
    after: { stage: after.stage, consultationAppointmentId: appointment.id, startsAt: appointment.startsAt.toISOString(), doctorId: input.doctorId },
  });
  const owners = await userNames(tenantId, [after.ownerId]);
  return { lead: toCard(after, owners), appointment: { id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, status: appointment.status } };
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

const followUpInclude = { lead: { select: { id: true, fullName: true, phone: true, stage: true, interests: true } } } as const;
type FollowUpRow = Prisma.LeadFollowUpGetPayload<{ include: typeof followUpInclude }>;

function toFollowUpDTO(row: FollowUpRow, owners: Map<string, { id: string; fullName: string }>): FollowUpDTO {
  return {
    id: row.id,
    leadId: row.leadId,
    lead: row.lead,
    owner: row.ownerId ? (owners.get(row.ownerId) ?? null) : null,
    dueAt: row.dueAt.toISOString(),
    note: row.note,
    channel: row.channel,
    doneAt: row.doneAt?.toISOString() ?? null,
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createFollowUp(tenantId: string, leadId: string, rawInput: unknown, actor: Actor = {}) {
  const input = FollowUpInput.parse(rawInput);
  const lead = await requireLead(tenantId, leadId);
  const ownerId = input.ownerId ?? lead.ownerId ?? actor.id ?? null;
  if (ownerId) await requireTenantUser(tenantId, ownerId);
  const row = await db.leadFollowUp.create({
    data: { tenantId, leadId, ownerId, dueAt: input.dueAt, note: input.note ?? null, channel: input.channel ?? null, createdById: actor.id ?? null },
    include: followUpInclude,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.followup.create",
    entity: "LeadFollowUp",
    entityId: row.id,
    after: { leadId, ownerId, dueAt: row.dueAt.toISOString(), note: row.note, channel: row.channel },
  });
  const owners = await userNames(tenantId, [ownerId]);
  return toFollowUpDTO(row, owners);
}

export async function completeFollowUp(tenantId: string, followUpId: string, rawInput: unknown, actor: Actor = {}) {
  const input = FollowUpCompleteInput.parse(rawInput);
  const before = await db.leadFollowUp.findFirst({ where: { id: followUpId, tenantId }, include: followUpInclude });
  if (!before) throw new TenantScopeError("lead", followUpId);
  if (before.doneAt) throw new LeadStateError("follow_up_done", "This follow-up is already done.");
  const now = new Date();
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.leadFollowUp.update({
      where: { id: followUpId, tenantId },
      data: { doneAt: now, doneById: actor.id ?? null, outcome: input.outcome },
      include: followUpInclude,
    });
    await tx.lead.update({ where: { id: before.leadId, tenantId }, data: { lastContactAt: now } });
    // The escalation opened for this follow-up (and any left over once nothing is overdue) resolves.
    const stillOverdue = await tx.leadFollowUp.count({ where: { tenantId, leadId: before.leadId, doneAt: null, dueAt: { lt: now } } });
    await tx.escalation.updateMany({
      where: {
        tenantId,
        leadId: before.leadId,
        kind: "LEAD_FOLLOW_UP",
        status: { not: "RESOLVED" },
        ...(stillOverdue ? { details: { path: ["followUpId"], equals: followUpId } } : {}),
      },
      data: { status: "RESOLVED", resolvedAt: now, resolvedById: actor.id ?? null, resolution: input.outcome },
    });
    return updated;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "lead.followup.complete",
    entity: "LeadFollowUp",
    entityId: followUpId,
    before: { doneAt: null },
    after: { doneAt: now.toISOString(), outcome: input.outcome },
  });
  const owners = await userNames(tenantId, [row.ownerId]);
  return toFollowUpDTO(row, owners);
}

export async function listLeadFollowUps(tenantId: string, leadId: string) {
  await requireLead(tenantId, leadId);
  const rows = await db.leadFollowUp.findMany({ where: { tenantId, leadId }, orderBy: [{ doneAt: "asc" }, { dueAt: "asc" }], take: 100, include: followUpInclude });
  const owners = await userNames(tenantId, rows.map((r) => r.ownerId));
  return rows.map((r) => toFollowUpDTO(r, owners));
}

/** Due today (clinic clock), overdue, or the acting user's open follow-ups. */
export async function listFollowUps(tenantId: string, scope: "due" | "overdue" | "mine", userId: string | null, now = new Date()) {
  const tz = await getTenantTimezone(tenantId);
  const where: Prisma.LeadFollowUpWhereInput = { tenantId, doneAt: null, lead: { ...notDeleted, stage: { not: "LOST" } } };
  if (scope === "due") where.dueAt = { gte: startOfDayInTz(now, tz), lte: endOfDayInTz(now, tz) };
  else if (scope === "overdue") where.dueAt = { lt: now };
  else where.ownerId = userId ?? "-";
  const rows = await db.leadFollowUp.findMany({ where, orderBy: { dueAt: "asc" }, take: 200, include: followUpInclude });
  const owners = await userNames(tenantId, rows.map((r) => r.ownerId));
  return rows.map((r) => toFollowUpDTO(r, owners));
}

export async function followUpCounts(tenantId: string, userId: string | null, now = new Date()) {
  const tz = await getTenantTimezone(tenantId);
  const open: Prisma.LeadFollowUpWhereInput = { tenantId, doneAt: null, lead: { ...notDeleted, stage: { not: "LOST" } } };
  const [due, overdue, mine] = await db.$transaction([
    db.leadFollowUp.count({ where: { ...open, dueAt: { gte: startOfDayInTz(now, tz), lte: endOfDayInTz(now, tz) } } }),
    db.leadFollowUp.count({ where: { ...open, dueAt: { lt: now } } }),
    db.leadFollowUp.count({ where: { ...open, ownerId: userId ?? "-" } }),
  ]);
  return { due, overdue, mine };
}

// ── Overdue sweep (job "crm-follow-ups") ─────────────────────────────────────

const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
const ESCALATION_TARGET_MS = 4 * 60 * 60 * 1000;

/**
 * For every active tenant: tell the owner once about each follow-up that
 * passed its time, and open one LEAD_FOLLOW_UP escalation per lead once a
 * follow-up is more than 24 hours overdue. Idempotent: the notification is
 * keyed on the follow-up id, the escalation on the lead's open one.
 */
export async function sweepOverdueFollowUps(now = new Date()): Promise<{ notified: number; escalated: number; tenants: number }> {
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", ...notDeleted }, select: { id: true } });
  let notified = 0;
  let escalated = 0;
  for (const tenant of tenants) {
    const result = await sweepTenantFollowUps(tenant.id, now);
    notified += result.notified;
    escalated += result.escalated;
  }
  return { notified, escalated, tenants: tenants.length };
}

export async function sweepTenantFollowUps(tenantId: string, now = new Date()): Promise<{ notified: number; escalated: number }> {
  const overdue = await db.leadFollowUp.findMany({
    where: { tenantId, doneAt: null, outcome: null, dueAt: { lt: now }, lead: { ...notDeleted, stage: { not: "LOST" } } },
    orderBy: { dueAt: "asc" },
    take: 500,
    include: { lead: { select: { id: true, fullName: true, patientId: true, ownerId: true } } },
  });
  if (!overdue.length) return { notified: 0, escalated: 0 };
  const tz = await getTenantTimezone(tenantId);

  const alreadyNotified = new Set(
    (
      await db.notification.findMany({
        where: { tenantId, kind: "FOLLOW_UP_OVERDUE", entity: "LeadFollowUp", entityId: { in: overdue.map((f) => f.id) } },
        select: { entityId: true },
      })
    ).map((n) => n.entityId),
  );
  const escalatedLeads = new Set(
    (
      await db.escalation.findMany({
        where: { tenantId, kind: "LEAD_FOLLOW_UP", status: { not: "RESOLVED" }, leadId: { in: overdue.map((f) => f.leadId) } },
        select: { leadId: true },
      })
    ).map((e) => e.leadId),
  );

  let notified = 0;
  let escalated = 0;
  for (const fu of overdue) {
    const ownerId = fu.ownerId ?? fu.lead.ownerId ?? null;
    const dueLabel = formatDateInTz(fu.dueAt, tz, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    if (!alreadyNotified.has(fu.id)) {
      await notify(tenantId, {
        kind: "FOLLOW_UP_OVERDUE",
        level: "WARNING",
        title: `Follow-up overdue: ${fu.lead.fullName}`,
        body: `${fu.note ? `${fu.note} · ` : ""}due ${dueLabel}`,
        href: `/dashboard/leads/${fu.leadId}`,
        entity: "LeadFollowUp",
        entityId: fu.id,
        userIds: ownerId ? [ownerId] : [],
        roles: ownerId ? ["CLINIC_OWNER"] : ["RECEPTIONIST", "CLINIC_OWNER"],
      }).catch((err) => console.error("[crm] FOLLOW_UP_OVERDUE notification failed", err));
      alreadyNotified.add(fu.id);
      notified += 1;
    }
    if (now.getTime() - fu.dueAt.getTime() >= ESCALATE_AFTER_MS && !escalatedLeads.has(fu.leadId)) {
      await db.escalation.create({
        data: {
          tenantId,
          kind: "LEAD_FOLLOW_UP",
          level: "WATCH",
          status: "OPEN",
          leadId: fu.leadId,
          patientId: fu.lead.patientId,
          assignedToId: ownerId,
          summary: `Lead ${fu.lead.fullName} waiting since ${formatDateInTz(fu.dueAt, tz)}`,
          details: { followUpId: fu.id, followUpDueAt: fu.dueAt.toISOString(), note: fu.note },
          dueAt: new Date(now.getTime() + ESCALATION_TARGET_MS),
        },
      });
      escalatedLeads.add(fu.leadId);
      escalated += 1;
    }
  }
  return { notified, escalated };
}

// ── Campaigns ────────────────────────────────────────────────────────────────

function dayToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

export async function listCampaigns(tenantId: string): Promise<CampaignDTO[]> {
  const [campaigns, costs, leadCounts, consultationCounts, wonCounts] = await Promise.all([
    db.campaign.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { createdAt: "desc" }], include: { treatment: { select: { id: true, key: true, name: true } } } }),
    db.campaignCost.groupBy({ by: ["campaignId"], where: { tenantId }, _sum: { amount: true } }),
    db.lead.groupBy({ by: ["campaignId"], where: { tenantId, ...notDeleted, campaignId: { not: null } }, _count: { _all: true } }),
    db.lead.groupBy({
      by: ["campaignId"],
      where: {
        tenantId,
        ...notDeleted,
        campaignId: { not: null },
        OR: [{ stage: { in: [...CONSULTATION_STAGES] } }, { lostAtStage: { in: [...CONSULTATION_STAGES] } }, { consultationAppointmentId: { not: null } }],
      },
      _count: { _all: true },
    }),
    db.lead.groupBy({ by: ["campaignId"], where: { tenantId, ...notDeleted, campaignId: { not: null }, stage: "WON" }, _count: { _all: true } }),
  ]);
  const costOf = new Map(costs.map((c) => [c.campaignId, c._sum.amount ?? 0]));
  const leadsOf = new Map(leadCounts.map((c) => [c.campaignId, c._count._all]));
  const consultOf = new Map(consultationCounts.map((c) => [c.campaignId, c._count._all]));
  const wonOf = new Map(wonCounts.map((c) => [c.campaignId, c._count._all]));
  return campaigns.map((c) => ({
    id: c.id,
    externalId: c.externalId,
    name: c.name,
    platform: c.platform,
    source: c.source,
    treatment: c.treatment,
    active: c.active,
    startedAt: c.startedAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    leads: leadsOf.get(c.id) ?? 0,
    consultations: consultOf.get(c.id) ?? 0,
    won: wonOf.get(c.id) ?? 0,
    totalCost: costOf.get(c.id) ?? 0,
  }));
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createCampaign(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = CampaignInput.parse(rawInput);
  if (input.treatmentId) await requireTenantTreatment(tenantId, input.treatmentId);
  let campaign;
  try {
    campaign = await db.campaign.create({
      data: {
        tenantId,
        externalId: input.externalId,
        name: input.name,
        platform: input.platform,
        source: input.source,
        treatmentId: input.treatmentId ?? null,
        active: input.active,
        startedAt: input.startedAt ? dayToDate(input.startedAt) : null,
        endedAt: input.endedAt ? dayToDate(input.endedAt) : null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new LeadStateError("duplicate_external_id", "A campaign with this platform id already exists.");
    throw err;
  }
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "campaign.create", entity: "Campaign", entityId: campaign.id, after: input });
  return campaign;
}

export async function updateCampaign(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const patch = definedEntries(CampaignUpdateInput.parse(rawInput));
  const before = await db.campaign.findFirst({ where: { id, tenantId } });
  if (!before) throw new TenantScopeError("campaign", id);
  if (patch.treatmentId) await requireTenantTreatment(tenantId, patch.treatmentId);
  let campaign;
  try {
    campaign = await db.campaign.update({
      where: { id, tenantId },
      data: {
        ...patch,
        startedAt: patch.startedAt === undefined ? undefined : patch.startedAt ? dayToDate(patch.startedAt) : null,
        endedAt: patch.endedAt === undefined ? undefined : patch.endedAt ? dayToDate(patch.endedAt) : null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new LeadStateError("duplicate_external_id", "A campaign with this platform id already exists.");
    throw err;
  }
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "campaign.update",
    entity: "Campaign",
    entityId: id,
    before: { name: before.name, externalId: before.externalId, active: before.active, treatmentId: before.treatmentId },
    after: patch,
  });
  return campaign;
}

export async function addCampaignCost(tenantId: string, campaignId: string, rawInput: unknown, actor: Actor = {}) {
  const input = CampaignCostInput.parse(rawInput);
  await requireCampaign(tenantId, campaignId);
  const cost = await db.campaignCost.create({
    data: { tenantId, campaignId, periodStart: dayToDate(input.periodStart), periodEnd: dayToDate(input.periodEnd), amount: input.amount, source: "manual", createdById: actor.id ?? null },
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "campaign.cost.add", entity: "CampaignCost", entityId: cost.id, after: { campaignId, ...input } });
  return cost;
}

/** Parse `periodStart,periodEnd,amount` rows (a header line and blank lines are skipped). Pure. */
export function parseCostCsv(text: string): { rows: { line: number; periodStart: string; periodEnd: string; amount: number }[]; errors: { line: number; message: string }[] } {
  const rows: { line: number; periodStart: string; periodEnd: string; amount: number }[] = [];
  const errors: { line: number; message: string }[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const cells = trimmed.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (i === 0 && /period|start|amount|cost/i.test(trimmed) && !/^\d/.test(cells[0] ?? "")) return; // header
    if (cells.length < 3) {
      errors.push({ line, message: "Expected three columns: periodStart,periodEnd,amount" });
      return;
    }
    if (!/\d/.test(cells[2] ?? "")) {
      errors.push({ line, message: "The amount is not a number" });
      return;
    }
    const parsed = CampaignCostInput.safeParse({ periodStart: cells[0], periodEnd: cells[1], amount: cells[2]?.replace(/[^\d.-]/g, "") });
    if (!parsed.success) {
      errors.push({ line, message: parsed.error.issues.map((is) => `${String(is.path[0] ?? "row")}: ${is.message}`).join("; ") });
      return;
    }
    rows.push({ line, ...parsed.data });
  });
  if (!rows.length && !errors.length) errors.push({ line: 0, message: "No rows found" });
  return { rows, errors };
}

/** Preview (default) or import a CSV of costs; importing with bad rows is a 422 listing them. */
export async function importCampaignCosts(tenantId: string, campaignId: string, rawInput: unknown, actor: Actor = {}): Promise<CostImportPreviewDTO> {
  const input = CostImportInput.parse(rawInput);
  await requireCampaign(tenantId, campaignId);
  const { rows, errors } = parseCostCsv(input.csv);
  if (!input.commit) return { rows, errors, imported: 0 };
  if (errors.length) throw new CrmValidationError({ csv: errors.map((e) => `Line ${e.line}: ${e.message}`) });
  const result = await db.campaignCost.createMany({
    data: rows.map((r) => ({ tenantId, campaignId, periodStart: dayToDate(r.periodStart), periodEnd: dayToDate(r.periodEnd), amount: r.amount, source: "csv", createdById: actor.id ?? null })),
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "campaign.cost.import",
    entity: "Campaign",
    entityId: campaignId,
    after: { rows: result.count, total: rows.reduce((s, r) => s + r.amount, 0) },
  });
  return { rows, errors, imported: result.count };
}

// ── Lookups for pickers ──────────────────────────────────────────────────────

/** Active staff of the tenant (any role) for owner / assignee pickers. */
export async function listTenantStaff(tenantId: string) {
  const users = await db.user.findMany({
    where: { tenantId, ...notDeleted, status: "ACTIVE" },
    orderBy: [{ role: "asc" }, { fullName: "asc" }],
    take: 200,
    select: { id: true, fullName: true, email: true, role: true },
  });
  return users.map((u) => ({ id: u.id, fullName: u.fullName ?? u.email, role: u.role }));
}

export async function listCampaignRefs(tenantId: string) {
  return db.campaign.findMany({ where: { tenantId }, orderBy: [{ active: "desc" }, { name: "asc" }], select: { id: true, name: true, platform: true, active: true } });
}

export type { LeadStageKey };
