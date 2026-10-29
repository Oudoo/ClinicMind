import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted, systemDb, withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { requireTenantClinic, requireTenantUser, TenantScopeError } from "@/lib/tenant-scope";
import { addDays, dateKeyInTz, formatDateInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { looksLikeToken, publicBaseUrl } from "@/modules/concierge/tokens";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import { notify } from "@/modules/notifications/service";
import { DISCOUNT_REASON_LABELS, DISCOUNT_REASONS, MAX_AMOUNT, type DiscountReasonValue, type PriceUnitValue } from "@/modules/finance/constants";
import { assertDiscountAllowed, discountReasonIssues } from "@/modules/finance/discounts";
import { stagesFor } from "@/modules/finance/charges";
import { priceOn } from "@/modules/finance/prices";
import { defaultClinicId, takeNumber } from "@/modules/finance/documents";
import { FinanceError } from "@/modules/finance/errors";
import {
  cleanSignature,
  countedUnit,
  MAX_ITEMS,
  MAX_PHASES,
  QUOTE_LANGUAGES,
  QUOTE_MAX_VALID_DAYS,
  QUOTE_VALID_DAYS,
  quoteState,
  quoteTotals,
  SIGNATURE_MAX_LENGTH,
  type QuoteLanguage,
  type QuoteState,
} from "./constants";
import { QUOTE_COPY } from "./copy";
import type { PublicQuoteDTO, QuoteDTO, QuoteItemDTO, QuoteListRow } from "./dto";

/**
 * Treatment plans and quotes. A draft is built from the price list in
 * phases (the item, how many, in how many sessions, where, a discount within
 * the role's limit with its reason), priced for its branch today, and
 * changes freely. Giving it to the patient — printed, sent on WhatsApp or
 * signed on the clinic's screen — numbers it in the branch's quote sequence
 * and fixes its items and prices until its last valid day (the database
 * refuses any change). The patient accepts it, all of it or some items, by
 * typing their name and signing, in the clinic or behind the link; the
 * accepted items become planned procedures at the quoted prices, with no day
 * yet, which the recall list picks up when nothing gets booked. A quote can
 * be declined, withdrawn, given more days, or revised into a new draft that
 * replaces it once given. Every change is audited.
 */

type Tx = Prisma.TransactionClient;

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
  /** The acting role: discounts are limited by it (none: an internal call, not limited). */
  role?: UserRole | null;
}

/** Signed on the clinic's screen (a staff member records it) or behind the link, on the patient's own phone. */
export type AcceptedVia = "clinic" | "link";

const QUOTE_PURPOSE = "quote" as const;

// ── Validation ───────────────────────────────────────────────────────────────

const zId = zText(64).min(1);
const zMoney = z.number().int().min(0).max(MAX_AMOUNT);
const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Optional text where a blank string means "clear" (null) and absence means "keep". */
const zClearableText = (max: number) => z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(max).nullable().optional());

const QuoteItemInput = z
  .object({
    /** An item already on the draft (or on the quote being revised): its discount, unchanged, keeps who gave it. */
    id: zOptionalText(64),
    priceItemId: zId,
    quantity: z.number().int().min(1).max(10_000).default(1),
    /** Where: the area treated. */
    site: zOptionalText(80),
    discount: zMoney.default(0),
    discountReason: z.enum(DISCOUNT_REASONS).optional(),
    discountNote: zOptionalText(300),
  })
  .superRefine((v, ctx) => {
    for (const [path, message] of Object.entries(discountReasonIssues(isNum(v.discount) ? v.discount : 0, v.discountReason, v.discountNote))) {
      ctx.addIssue({ code: "custom", path: [path], message });
    }
  });

const QuotePhaseInput = z.object({
  title: zText(80).min(1, "Give the phase a heading"),
  items: z.array(QuoteItemInput).min(1, "Add at least one treatment to the phase").max(MAX_ITEMS),
});
type PhaseInput = z.infer<typeof QuotePhaseInput>;

const zPhases = z
  .array(QuotePhaseInput)
  .min(1, "Add a phase")
  .max(MAX_PHASES, `At most ${MAX_PHASES} phases`)
  .superRefine((phases, ctx) => {
    if (phases.reduce((n, p) => n + p.items.length, 0) > MAX_ITEMS) ctx.addIssue({ code: "custom", message: `At most ${MAX_ITEMS} treatments in one plan` });
  });

export const QuoteDraftInput = z.object({
  patientId: zId,
  /** The branch it is priced and numbered at; the clinic's first location when not given. */
  clinicId: zOptionalText(64),
  doctorId: zOptionalText(64),
  language: z.enum(QUOTE_LANGUAGES).optional(),
  title: zOptionalText(120),
  note: zOptionalText(1000),
  /** The last day it holds (YYYY-MM-DD, clinic clock); 30 days from today when not given. */
  validUntil: zDayKey.optional(),
  phases: zPhases,
});

export const QuoteDraftUpdate = z.object({
  clinicId: zOptionalText(64),
  doctorId: zClearableText(64),
  language: z.enum(QUOTE_LANGUAGES).optional(),
  title: zClearableText(120),
  note: zClearableText(1000),
  validUntil: zDayKey.optional(),
  /** The whole plan again: its items are replaced (and priced for today). */
  phases: zPhases.optional(),
});

export const QuoteAcceptInput = z.object({
  itemIds: z.array(zId).min(1, "Choose at least one treatment").max(MAX_ITEMS),
  name: zText(120).min(2, "Type the patient's full name"),
  signature: z
    .string()
    .max(SIGNATURE_MAX_LENGTH)
    .transform((s, ctx) => {
      const clean = cleanSignature(s);
      if (!clean) {
        ctx.addIssue({ code: "custom", message: "Sign in the box: a little more than a dot" });
        return z.NEVER;
      }
      return clean;
    }),
  agree: z.literal(true, { error: "Tick the box to accept" }),
});

export const QuoteDeclineInput = z.object({ reason: zOptionalText(500) });
export const QuoteWithdrawInput = z.object({ reason: zText(300).min(3, "Say why the quote is withdrawn") });
export const QuoteExtendInput = z.object({ validUntil: zDayKey });

export const QUOTE_LIST_STATES = ["DRAFT", "SENT", "EXPIRED", "ACCEPTED", "DECLINED", "WITHDRAWN"] as const satisfies readonly QuoteState[];

export const QuoteListQuery = z.object({
  patientId: zOptionalText(64),
  state: z.enum(QUOTE_LIST_STATES).optional(),
  q: zOptionalText(60),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ── Errors ───────────────────────────────────────────────────────────────────

export class QuoteNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `quote ${id} not found in tenant`, { entity: "quote" });
    this.name = "QuoteNotFoundError";
  }
}

function quoteStateError(state: QuoteState, action: string, message: string) {
  return new FinanceError(409, "invalid_state", `a ${state} quote cannot be ${action}`, { status: state, action, message });
}

function issue(path: (string | number)[], message: string) {
  return new z.ZodError([{ code: "custom", path, message }]);
}

// ── Reading ──────────────────────────────────────────────────────────────────

const quoteInclude = {
  clinic: { select: { id: true, name: true, code: true, address: true, phone: true } },
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, language: true } },
  items: {
    orderBy: { position: "asc" },
    include: {
      priceItem: { select: { code: true, unit: true, unitLabel: true } },
      treatment: { select: { name: true } },
      procedure: { select: { id: true, status: true } },
    },
  },
} satisfies Prisma.QuoteInclude;

type QuoteRow = Prisma.QuoteGetPayload<{ include: typeof quoteInclude }>;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDTO(
  row: QuoteRow,
  extra: { tenantName: string; timezone: string; doctor: { id: string; fullName: string } | null; revisionOf: { id: string; number: string | null } | null; revisions: QuoteDTO["revisions"]; now: Date },
): QuoteDTO {
  const items: QuoteItemDTO[] = row.items.map((i) => ({
    id: i.id,
    phase: i.phase,
    position: i.position,
    priceItemId: i.priceItemId,
    code: i.priceItem.code,
    treatmentId: i.treatmentId,
    treatmentName: i.treatment.name,
    description: i.description,
    site: i.site,
    unit: i.priceItem.unit as PriceUnitValue,
    unitLabel: i.priceItem.unitLabel,
    quantity: i.quantity,
    stages: i.stages,
    unitPrice: i.unitPrice,
    price: i.price,
    discount: i.discount,
    discountReason: i.discountReason,
    discountNote: i.discountNote,
    net: i.price - i.discount,
    accepted: i.accepted,
    procedure: i.procedure,
  }));
  const totals = quoteTotals(items);
  const validUntilKey = dateKeyInTz(row.validUntil, extra.timezone);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    state: quoteState(row.status, validUntilKey, dateKeyInTz(extra.now, extra.timezone)),
    language: row.language === "ar" ? "ar" : "en",
    title: row.title,
    phases: row.phases,
    note: row.note,
    validUntil: row.validUntil.toISOString(),
    validUntilKey,
    listTotal: totals.list,
    discountTotal: totals.discount,
    total: row.total,
    createdAt: row.createdAt.toISOString(),
    sentAt: iso(row.sentAt),
    linkSentAt: iso(row.linkSentAt),
    acceptedAt: iso(row.acceptedAt),
    acceptedName: row.acceptedName,
    signature: row.signature,
    acceptedVia: row.acceptedVia === "clinic" || row.acceptedVia === "link" ? row.acceptedVia : null,
    acceptedTotal: row.acceptedTotal,
    declinedAt: iso(row.declinedAt),
    declineReason: row.declineReason,
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnReason: row.withdrawnReason,
    revisionOf: extra.revisionOf,
    revisions: extra.revisions,
    tenantName: extra.tenantName,
    timezone: extra.timezone,
    clinic: row.clinic,
    patient: { id: row.patient.id, fullName: row.patient.fullName, phone: row.patient.whatsapp ?? row.patient.phone, language: row.patient.language },
    doctor: extra.doctor,
    items,
  };
}

async function load(tenantId: string, id: string, now = new Date()): Promise<QuoteDTO> {
  const row = await db.quote.findFirst({ where: { id, tenantId }, include: quoteInclude });
  if (!row) throw new QuoteNotFoundError(id);
  const [tenant, timezone, doctor, revisionOf, revisions] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    getTenantTimezone(tenantId),
    row.doctorId ? db.user.findFirst({ where: { id: row.doctorId, tenantId }, select: { id: true, fullName: true, email: true } }) : null,
    row.revisionOfId ? db.quote.findFirst({ where: { id: row.revisionOfId, tenantId }, select: { id: true, number: true } }) : null,
    db.quote.findMany({ where: { tenantId, revisionOfId: id }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, status: true } }),
  ]);
  return toDTO(row, {
    tenantName: tenant?.name ?? "",
    timezone,
    doctor: doctor ? { id: doctor.id, fullName: doctor.fullName ?? doctor.email } : null,
    revisionOf,
    revisions,
    now,
  });
}

export async function getQuote(tenantId: string, id: string): Promise<QuoteDTO> {
  return load(tenantId, id);
}

export async function listQuotes(tenantId: string, rawQuery: unknown = {}, now = new Date()) {
  const query = QuoteListQuery.parse(rawQuery);
  const timezone = await getTenantTimezone(tenantId);
  const today = startOfDayInTz(now, timezone);
  const byState: Prisma.QuoteWhereInput =
    query.state === "SENT"
      ? { status: "SENT", validUntil: { gte: today } }
      : query.state === "EXPIRED"
        ? { status: "SENT", validUntil: { lt: today } }
        : query.state
          ? { status: query.state }
          : {};
  const where: Prisma.QuoteWhereInput = {
    tenantId,
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...byState,
    ...(query.q
      ? { OR: [{ number: { contains: query.q, mode: "insensitive" } }, { title: { contains: query.q, mode: "insensitive" } }, { patient: { fullName: { contains: query.q, mode: "insensitive" } } }] }
      : {}),
  };
  const [rows, total] = await db.$transaction([
    db.quote.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        title: true,
        total: true,
        acceptedTotal: true,
        validUntil: true,
        createdAt: true,
        sentAt: true,
        doctorId: true,
        patientId: true,
        patient: { select: { fullName: true } },
      },
    }),
    db.quote.count({ where }),
  ]);
  const doctorIds = [...new Set(rows.map((r) => r.doctorId).filter((d): d is string => Boolean(d)))];
  const doctors = doctorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const doctorName = new Map(doctors.map((d) => [d.id, d.fullName ?? d.email]));
  const todayKey = dateKeyInTz(now, timezone);
  return {
    quotes: rows.map((r): QuoteListRow => {
      const validUntilKey = dateKeyInTz(r.validUntil, timezone);
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        state: quoteState(r.status, validUntilKey, todayKey),
        title: r.title,
        total: r.total,
        acceptedTotal: r.acceptedTotal,
        patientId: r.patientId,
        patientName: r.patient.fullName,
        doctorName: r.doctorId ? (doctorName.get(r.doctorId) ?? null) : null,
        validUntilKey,
        createdAt: r.createdAt.toISOString(),
        sentAt: iso(r.sentAt),
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
    timezone,
  };
}

// ── Pricing a draft ──────────────────────────────────────────────────────────

/** An item as stored: priced, counted and with its discount's giver. */
interface PricedItem {
  phase: number;
  position: number;
  priceItemId: string;
  treatmentId: string;
  description: string;
  site: string | null;
  quantity: number;
  stages: number;
  unitPrice: number;
  price: number;
  discount: number;
  discountReason: string | null;
  discountNote: string | null;
  discountById: string | null;
}

/** What a discount given before was: kept as it is when nothing about it changed. */
interface GivenDiscount {
  priceItemId: string;
  quantity: number;
  price: number;
  discount: number;
  discountReason: string | null;
  discountNote: string | null;
  discountById: string | null;
}

/**
 * The plan's items priced for a branch today: the list price on the day
 * times how many (a visit and a course package count as one), the sessions
 * it is done in, and each discount within the actor's limit — unless it is
 * the very discount given before on that item (same item, count, amount and
 * reason, at a price no lower), which keeps its giver.
 */
async function priceItems(tx: Tx, tenantId: string, clinicId: string, phases: readonly PhaseInput[], actor: Actor, now: Date, given: ReadonlyMap<string, GivenDiscount>): Promise<PricedItem[]> {
  const ids = [...new Set(phases.flatMap((p) => p.items.map((i) => i.priceItemId)))];
  const rows = await tx.priceItem.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, treatmentId: true, active: true, unit: true, sessions: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: PricedItem[] = [];
  let position = 0;
  for (const [p, phase] of phases.entries()) {
    for (const [j, input] of phase.items.entries()) {
      const path = ["phases", p, "items", j];
      const item = byId.get(input.priceItemId);
      if (!item) throw new TenantScopeError("price_item", input.priceItemId);
      if (!item.active) throw issue([...path, "priceItemId"], `${item.name} is no longer on the price list`);
      const unitPrice = await priceOn(tenantId, item.id, now, clinicId, tx);
      if (unitPrice === null) throw issue([...path, "priceItemId"], `${item.name} has no price on the list today`);
      const quantity = countedUnit(item.unit) ? input.quantity : 1;
      const price = unitPrice * quantity;
      if (price > MAX_AMOUNT) throw issue([...path, "quantity"], "That comes to more than a quote can hold");
      if (input.discount > price) throw issue([...path, "discount"], "The discount cannot be more than the price");
      const discountReason = input.discount > 0 ? (input.discountReason ?? null) : null;
      const discountNote = input.discount > 0 ? (input.discountNote ?? null) : null;
      const before = input.id ? given.get(input.id) : undefined;
      const unchanged =
        before !== undefined &&
        before.priceItemId === item.id &&
        before.quantity === quantity &&
        before.discount === input.discount &&
        before.discountReason === discountReason &&
        before.discountNote === discountNote &&
        price >= before.price;
      let discountById: string | null = null;
      if (input.discount > 0) {
        if (unchanged) {
          discountById = before.discountById;
        } else {
          try {
            await assertDiscountAllowed(tenantId, actor.role, price, input.discount, tx);
          } catch (err) {
            if (err instanceof FinanceError && err.code === "discount_limit") {
              throw new FinanceError(403, "discount_limit", err.message, { ...err.extra, message: `${item.name}: ${String(err.extra.message ?? "")}`, path });
            }
            throw err;
          }
          discountById = actor.id ?? null;
        }
      }
      position += 1;
      out.push({
        phase: p,
        position,
        priceItemId: item.id,
        treatmentId: item.treatmentId,
        description: item.name,
        site: input.site ?? null,
        quantity,
        stages: stagesFor(item, quantity),
        unitPrice,
        price,
        discount: input.discount,
        discountReason,
        discountNote,
        discountById,
      });
    }
  }
  return out;
}

/** The plan as the editor sends it, from stored items (to price them again, or to revise them). */
function phasesOf(phases: readonly string[], items: readonly { id: string; phase: number; priceItemId: string; quantity: number; site: string | null; discount: number; discountReason: string | null; discountNote: string | null }[]): PhaseInput[] {
  return phases
    .map((title, p) => ({
      title,
      items: items
        .filter((i) => i.phase === p)
        .map((i) => ({
          id: i.id,
          priceItemId: i.priceItemId,
          quantity: i.quantity,
          site: i.site ?? undefined,
          discount: i.discount,
          discountReason: (i.discountReason ?? undefined) as DiscountReasonValue | undefined,
          discountNote: i.discountNote ?? undefined,
        })),
    }))
    .filter((p) => p.items.length > 0);
}

/** The last valid day from its key: today or later, within a year; 30 days from today when not given. */
function lastValidDay(key: string | undefined, timezone: string, now: Date): Date {
  const today = startOfDayInTz(now, timezone);
  if (!key) return addDays(today, QUOTE_VALID_DAYS, timezone);
  const day = fromDateKey(key, timezone);
  if (!day) throw issue(["validUntil"], "Not a real date");
  if (day.getTime() < today.getTime()) throw issue(["validUntil"], "Today or later");
  if (day.getTime() > addDays(today, QUOTE_MAX_VALID_DAYS, timezone).getTime()) throw issue(["validUntil"], "Within a year from today");
  return day;
}

/** Past its last valid day, on the clinic clock. */
function isExpired(validUntil: Date, now: Date, timezone: string): boolean {
  return startOfDayInTz(now, timezone).getTime() > validUntil.getTime();
}

const money = (n: number) => n.toLocaleString("en-US");

// ── Drafts ───────────────────────────────────────────────────────────────────

/**
 * A draft for a patient, priced for its branch today. `revisionOf`: the
 * quote it revises (its discounts, unchanged, keep their giver; once this
 * one is given, that one is withdrawn).
 */
export async function createDraft(tenantId: string, rawInput: unknown, actor: Actor = {}, opts: { revisionOf?: { id: string; items: readonly (GivenDiscount & { id: string })[] }; now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteDraftInput.parse(rawInput);
  const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true, language: true } });
  if (!patient) throw new TenantScopeError("patient", input.patientId);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const validUntil = lastValidDay(input.validUntil, timezone, now);
  const given = new Map((opts.revisionOf?.items ?? []).map((i) => [i.id, i]));
  const created = await db.$transaction(async (tx) => {
    const clinicId = input.clinicId ? (await requireTenantClinic(tenantId, input.clinicId, tx)).id : await defaultClinicId(tx, tenantId);
    if (!clinicId) throw new FinanceError(409, "no_branch", "the clinic has no location", { message: "Add the clinic's location in Settings before making a quote." });
    const items = await priceItems(tx, tenantId, clinicId, input.phases, actor, now, given);
    const quote = await tx.quote.create({
      data: {
        tenantId,
        clinicId,
        patientId: patient.id,
        doctorId: input.doctorId ?? null,
        status: "DRAFT",
        language: input.language ?? (patient.language === "ar" ? "ar" : "en"),
        title: input.title ?? null,
        phases: input.phases.map((p) => p.title),
        note: input.note ?? null,
        validUntil,
        total: quoteTotals(items).total,
        revisionOfId: opts.revisionOf?.id ?? null,
        createdById: actor.id ?? null,
        createdAt: now,
        items: { create: items.map((i) => ({ tenantId, ...i })) },
      },
      select: { id: true, total: true },
    });
    return quote;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: opts.revisionOf ? "quote.revise" : "quote.draft",
    entity: "Quote",
    entityId: created.id,
    after: { patientId: patient.id, total: created.total, items: input.phases.reduce((n, p) => n + p.items.length, 0), revisionOf: opts.revisionOf?.id },
  });
  return load(tenantId, created.id, now);
}

async function lock(tx: Tx, tenantId: string, id: string) {
  // Two people giving or accepting it at once: one waits for the other.
  await tx.$queryRaw`SELECT id FROM "quotes" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
}

/** Change a draft: its branch, doctor, language, heading, note, last valid day, or the whole plan (priced for today). */
export async function updateDraft(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteDraftUpdate.parse(rawInput);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const validUntil = input.validUntil ? lastValidDay(input.validUntil, timezone, now) : undefined;
  const total = await db.$transaction(async (tx) => {
    await lock(tx, tenantId, id);
    const quote = await tx.quote.findFirst({ where: { id, tenantId }, include: { items: { orderBy: { position: "asc" } } } });
    if (!quote) throw new QuoteNotFoundError(id);
    if (quote.status !== "DRAFT") throw quoteStateError(quote.status, "changed", "A quote given to the patient never changes: revise it to make a new one.");
    const clinicId = input.clinicId ? (await requireTenantClinic(tenantId, input.clinicId, tx)).id : quote.clinicId;
    const data: Prisma.QuoteUncheckedUpdateInput = {
      clinicId,
      ...(input.doctorId !== undefined ? { doctorId: input.doctorId } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(validUntil ? { validUntil } : {}),
    };
    let total = quote.total;
    if (input.phases || clinicId !== quote.clinicId) {
      // The plan as sent, or (for another branch) the same plan priced there.
      const phases = input.phases ?? phasesOf(quote.phases, quote.items);
      const items = await priceItems(tx, tenantId, clinicId, phases, actor, now, new Map(quote.items.map((i) => [i.id, i])));
      await tx.quoteItem.deleteMany({ where: { tenantId, quoteId: id } });
      await tx.quoteItem.createMany({ data: items.map((i) => ({ tenantId, quoteId: id, ...i })) });
      total = quoteTotals(items).total;
      data.phases = phases.map((p) => p.title);
      data.total = total;
    }
    await tx.quote.update({ where: { id }, data });
    return total;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "quote.update",
    entity: "Quote",
    entityId: id,
    after: { ...input, phases: input.phases ? input.phases.length : undefined, total },
  });
  return load(tenantId, id, now);
}

/** Discard a draft: it was never given, so nothing is kept. */
export async function discardDraft(tenantId: string, id: string, actor: Actor = {}): Promise<void> {
  const patientId = await db.$transaction(async (tx) => {
    await lock(tx, tenantId, id);
    const quote = await tx.quote.findFirst({ where: { id, tenantId }, select: { status: true, patientId: true } });
    if (!quote) throw new QuoteNotFoundError(id);
    if (quote.status !== "DRAFT") throw quoteStateError(quote.status, "discarded", "A quote given to the patient is kept: withdraw it instead.");
    await tx.quote.delete({ where: { id } });
    return quote.patientId;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.discard", entity: "Quote", entityId: id, after: { patientId } });
}

// ── Giving it to the patient ─────────────────────────────────────────────────

type LockedQuote = Prisma.QuoteGetPayload<{ include: { items: true } }>;

async function lockedQuote(tx: Tx, tenantId: string, id: string): Promise<LockedQuote> {
  await lock(tx, tenantId, id);
  const quote = await tx.quote.findFirst({ where: { id, tenantId }, include: { items: { orderBy: { position: "asc" } } } });
  if (!quote) throw new QuoteNotFoundError(id);
  return quote;
}

/**
 * Give a draft inside the caller's transaction: its last valid day still
 * ahead, every item still on the list at the price it was saved with, then
 * the branch's next quote number. The quote it revises, if still open, is
 * withdrawn: this one replaces it.
 */
interface Given {
  number: string;
  /** The quote it revised, withdrawn now that this one replaces it. */
  replaced: { id: string; number: string | null } | null;
}

async function giveInTx(tx: Tx, tenantId: string, quote: LockedQuote, actor: Actor, now: Date, timezone: string): Promise<Given> {
  if (isExpired(quote.validUntil, now, timezone)) {
    throw quoteStateError("DRAFT", "given", "Its last valid day has passed: set a new one before giving it.");
  }
  for (const item of quote.items) {
    const row = await tx.priceItem.findFirst({ where: { id: item.priceItemId, tenantId }, select: { active: true } });
    const today = row?.active ? await priceOn(tenantId, item.priceItemId, now, quote.clinicId, tx) : null;
    if (today !== item.unitPrice) {
      throw new FinanceError(409, "prices_changed", "the price list changed since the draft was saved", {
        message: `The price list changed since this draft was saved (${item.description}): open it and save it again to use today's prices.`,
      });
    }
  }
  const { sequence, number } = await takeNumber(tx, tenantId, quote.clinicId, "QUOTE");
  await tx.quote.update({ where: { id: quote.id }, data: { status: "SENT", sequence, number, sentAt: now, sentById: actor.id ?? null } });
  let replaced: Given["replaced"] = null;
  if (quote.revisionOfId) {
    const { count } = await tx.quote.updateMany({
      where: { id: quote.revisionOfId, tenantId, status: "SENT" },
      data: { status: "WITHDRAWN", withdrawnAt: now, withdrawnReason: `Replaced by ${number}` },
    });
    if (count) replaced = await tx.quote.findFirst({ where: { id: quote.revisionOfId, tenantId }, select: { id: true, number: true } });
  }
  await tx.timelineEvent.create({
    data: { tenantId, patientId: quote.patientId, kind: "DOCUMENT", title: `Treatment plan ${number} given — ${money(quote.total)} EGP`, body: replaced ? `Replaces ${replaced.number}` : null, refId: quote.id, occurredAt: now },
  });
  return { number, replaced };
}

/** The audit of a quote given, and of the one it replaced. */
async function auditGiven(tenantId: string, id: string, given: Given, actor: Actor) {
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.give", entity: "Quote", entityId: id, after: { number: given.number, replaces: given.replaced?.number ?? undefined } });
  if (given.replaced) {
    await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.withdraw", entity: "Quote", entityId: given.replaced.id, after: { number: given.replaced.number, reason: `Replaced by ${given.number}` } });
  }
}

/** Give a draft (to print it): numbered from now on. A quote given already stays as it is. */
export async function giveQuote(tenantId: string, id: string, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const given = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    if (quote.status !== "DRAFT") return null;
    return giveInTx(tx, tenantId, quote, actor, now, timezone);
  });
  if (given) await auditGiven(tenantId, id, given, actor);
  return load(tenantId, id, now);
}

export function quoteLink(token: string): string {
  return `${publicBaseUrl()}/q/${token}`;
}

/** "28 Nov 2026" / "٢٨ نوفمبر ٢٠٢٦" with Latin digits, on the clinic clock. */
export function quoteDate(isoDate: string, timezone: string, language: QuoteLanguage): string {
  return formatDateInTz(new Date(isoDate), timezone, { day: "numeric", month: "long", year: "numeric" }, QUOTE_COPY[language].locale);
}

/** The WhatsApp message that carries the link, in the quote's language. */
export function quoteMessage(quote: Pick<QuoteDTO, "language" | "number" | "tenantName" | "total" | "validUntil" | "timezone" | "patient">, link: string): string {
  const first = quote.patient.fullName.split(/\s+/)[0] ?? quote.patient.fullName;
  const until = quoteDate(quote.validUntil, quote.timezone, quote.language);
  if (quote.language === "ar") {
    return `مرحبًا ${first}، خطة علاجك رقم ${quote.number} من ${quote.tenantName} بإجمالي ${money(quote.total)} جنيه، سارية حتى ${until}. يمكنك الاطلاع عليها والموافقة عليها من هنا: ${link}`;
  }
  return `Hi ${first}, your treatment plan ${quote.number} from ${quote.tenantName}: ${money(quote.total)} EGP, valid until ${until}. See it and accept it here: ${link}`;
}

/**
 * Send the patient the link on WhatsApp (giving a draft first): a fresh
 * link each time, the last one sent being the one that works.
 */
export async function sendQuote(tenantId: string, id: string, actor: Actor = {}, opts: { now?: Date } = {}) {
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const token = generateToken();
  const given = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    let given: Given | null = null;
    if (quote.status === "DRAFT") given = await giveInTx(tx, tenantId, quote, actor, now, timezone);
    else if (quote.status !== "SENT") throw quoteStateError(quote.status, "sent", "An accepted, declined or withdrawn quote is not sent again.");
    else if (isExpired(quote.validUntil, now, timezone)) throw quoteStateError("EXPIRED", "sent", "This quote has expired: give it more days first.");
    await tx.quote.update({ where: { id }, data: { shareTokenHash: hashToken(token, QUOTE_PURPOSE), linkSentAt: now } });
    return given;
  });
  if (given) await auditGiven(tenantId, id, given, actor);
  const quote = await load(tenantId, id, now);
  const link = quoteLink(token);
  const sent = await sendPatientMessage(tenantId, {
    patientId: quote.patient.id,
    body: quoteMessage(quote, link),
    templateKey: "quote:send",
    authorId: actor.id ?? null,
    author: "HUMAN",
    meta: { quoteId: id, number: quote.number },
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.send", entity: "Quote", entityId: id, after: { number: quote.number, delivery: sent.delivery } });
  return { link, delivery: sent.delivery, conversationId: sent.conversationId, messageId: sent.messageId, quote };
}

// ── Answers ──────────────────────────────────────────────────────────────────

/**
 * Accept a quote: the items chosen (one at least), the name typed and the
 * signature drawn. On the clinic's screen a draft is given in the same step;
 * behind the link only a quote given and still open can be. Each accepted
 * item becomes a planned procedure at its quoted price and discount, for the
 * quote's doctor, with no day yet (work done at once is dated the day it is
 * signed); the recall list picks it up if nothing is booked for it.
 */
export async function acceptQuote(tenantId: string, id: string, rawInput: unknown, via: AcceptedVia, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteAcceptInput.parse(rawInput);
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const done = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    let number = quote.number;
    let given: Given | null = null;
    if (quote.status === "DRAFT") {
      // A draft has no link: it is accepted only on the clinic's screen.
      if (via === "link") throw new QuoteNotFoundError(id);
      given = await giveInTx(tx, tenantId, quote, actor, now, timezone);
      number = given.number;
    } else if (quote.status !== "SENT") {
      throw quoteStateError(quote.status, "accepted", "This quote is no longer open.");
    } else if (isExpired(quote.validUntil, now, timezone)) {
      throw quoteStateError("EXPIRED", "accepted", "This quote has expired: give it more days, or revise it.");
    }
    const chosen = new Set(input.itemIds);
    if (input.itemIds.some((itemId) => !quote.items.some((i) => i.id === itemId))) throw issue(["itemIds"], "Choose among the plan's treatments");
    const created: { procedureId: string; item: (typeof quote.items)[number] }[] = [];
    let acceptedTotal = 0;
    for (const item of quote.items) {
      if (!chosen.has(item.id)) {
        await tx.quoteItem.update({ where: { id: item.id }, data: { accepted: false } });
        continue;
      }
      const net = item.price - item.discount;
      acceptedTotal += net;
      const procedure = await tx.procedure.create({
        data: {
          tenantId,
          patientId: quote.patientId,
          treatmentId: item.treatmentId,
          priceItemId: item.priceItemId,
          quantity: item.quantity,
          stages: item.stages,
          doctorId: quote.doctorId,
          performedAt: now,
          undated: true,
          price: item.price,
          discount: item.discount,
          discountReason: item.discount > 0 ? item.discountReason : null,
          discountNote: item.discount > 0 ? item.discountNote : null,
          discountById: item.discount > 0 ? item.discountById : null,
          zeroChargeReason: net === 0 ? `Included in treatment plan ${number}` : null,
          notes: [item.site ? `Site: ${item.site}` : null, `Treatment plan ${number}`].filter(Boolean).join(" · "),
          status: "PLANNED",
          createdById: actor.id ?? null,
          createdAt: now,
        },
        select: { id: true },
      });
      created.push({ procedureId: procedure.id, item });
      await tx.quoteItem.update({ where: { id: item.id }, data: { accepted: true, procedureId: procedure.id } });
    }
    await tx.quote.update({
      where: { id },
      data: {
        status: "ACCEPTED",
        acceptedAt: now,
        acceptedName: input.name,
        signature: input.signature,
        acceptedVia: via,
        acceptedById: via === "clinic" ? (actor.id ?? null) : null,
        acceptedTotal,
      },
    });
    const all = created.length === quote.items.length;
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: quote.patientId,
        kind: "DOCUMENT",
        title: `Treatment plan ${number} accepted — ${money(acceptedTotal)} EGP`,
        body: `${all ? "Every treatment" : `${created.length} of ${quote.items.length} treatments`}, signed ${via === "clinic" ? "at the clinic" : "online"} by ${input.name}`,
        refId: id,
        occurredAt: now,
      },
    });
    return { number, given, acceptedTotal, created, of: quote.items.length, patientId: quote.patientId };
  });

  if (done.given) await auditGiven(tenantId, id, done.given, actor);
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "quote.accept",
    entity: "Quote",
    entityId: id,
    after: { number: done.number, via, name: input.name, acceptedTotal: done.acceptedTotal, items: done.created.length, of: done.of, procedureIds: done.created.map((c) => c.procedureId) },
  });
  for (const { procedureId, item } of done.created) {
    await audit({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      ip: actor.ip,
      action: "procedure.create",
      entity: "Procedure",
      entityId: procedureId,
      after: { patientId: done.patientId, treatmentId: item.treatmentId, priceItemId: item.priceItemId, quantity: item.quantity, stages: item.stages, price: item.price, discount: item.discount, status: "PLANNED", quote: done.number },
    });
  }
  const quote = await load(tenantId, id, now);
  if (via === "link") await tellTheClinic(tenantId, quote, "accepted");
  return quote;
}

/** Record that the patient declined (a reason when they gave one). */
export async function declineQuote(tenantId: string, id: string, rawInput: unknown, via: AcceptedVia, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteDeclineInput.parse(rawInput ?? {});
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const number = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    if (quote.status === "DRAFT" && via === "link") throw new QuoteNotFoundError(id);
    if (quote.status !== "SENT") throw quoteStateError(quote.status, "declined", quote.status === "DRAFT" ? "A draft was never given: discard it instead." : "This quote is no longer open.");
    if (via === "link" && isExpired(quote.validUntil, now, timezone)) throw quoteStateError("EXPIRED", "declined", "This quote is no longer open.");
    await tx.quote.update({ where: { id }, data: { status: "DECLINED", declinedAt: now, declineReason: input.reason ?? null } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: quote.patientId, kind: "DOCUMENT", title: `Treatment plan ${quote.number} declined`, body: input.reason ?? null, refId: id, occurredAt: now },
    });
    return quote.number;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.decline", entity: "Quote", entityId: id, after: { number, via, reason: input.reason ?? null } });
  const quote = await load(tenantId, id, now);
  if (via === "link") await tellTheClinic(tenantId, quote, "declined");
  return quote;
}

/** The doctor who proposed it and the front desk hear when a patient answers from the link. */
async function tellTheClinic(tenantId: string, quote: QuoteDTO, answer: "accepted" | "declined") {
  await notify(tenantId, {
    kind: "QUOTE_ANSWERED",
    level: answer === "accepted" ? "INFO" : "WARNING",
    title: `${quote.patient.fullName} ${answer} treatment plan ${quote.number}`,
    body:
      answer === "accepted"
        ? `${money(quote.acceptedTotal ?? 0)} of ${money(quote.total)} EGP accepted: book the first session.`
        : quote.declineReason
          ? `"${quote.declineReason}"`
          : "No reason given.",
    href: `/dashboard/quotes/${quote.id}`,
    entity: "Quote",
    entityId: quote.id,
    userIds: quote.doctor ? [quote.doctor.id] : [],
    roles: ["RECEPTIONIST"],
  }).catch((err: unknown) => console.error(`[quotes] notifying the clinic of quote ${quote.id} failed`, err));
}

/** Take back a quote still open (or expired): the clinic changed the plan or the patient will not go ahead. */
export async function withdrawQuote(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteWithdrawInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const number = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    if (quote.status !== "SENT") throw quoteStateError(quote.status, "withdrawn", quote.status === "DRAFT" ? "A draft was never given: discard it instead." : "This quote is closed already.");
    await tx.quote.update({ where: { id }, data: { status: "WITHDRAWN", withdrawnAt: now, withdrawnReason: input.reason } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: quote.patientId, kind: "DOCUMENT", title: `Treatment plan ${quote.number} withdrawn`, body: input.reason, refId: id, occurredAt: now },
    });
    return quote.number;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.withdraw", entity: "Quote", entityId: id, after: { number, reason: input.reason } });
  return load(tenantId, id, now);
}

/** A new last valid day for a quote given and not answered (an expired one opens again). */
export async function extendQuote(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const input = QuoteExtendInput.parse(rawInput);
  const timezone = await getTenantTimezone(tenantId);
  const now = opts.now ?? new Date();
  const validUntil = lastValidDay(input.validUntil, timezone, now);
  const before = await db.$transaction(async (tx) => {
    const quote = await lockedQuote(tx, tenantId, id);
    if (quote.status !== "SENT") throw quoteStateError(quote.status, "extended", quote.status === "DRAFT" ? "Change a draft's last valid day in the draft itself." : "This quote is closed.");
    await tx.quote.update({ where: { id }, data: { validUntil } });
    return dateKeyInTz(quote.validUntil, timezone);
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "quote.extend", entity: "Quote", entityId: id, before: { validUntil: before }, after: { validUntil: input.validUntil } });
  return load(tenantId, id, now);
}

/**
 * A new draft from a quote given: the same plan priced for today, its
 * discounts kept as they were given. Once given, it replaces this one if
 * this one is still open.
 */
export async function reviseQuote(tenantId: string, id: string, actor: Actor = {}, opts: { now?: Date } = {}): Promise<QuoteDTO> {
  const quote = await db.quote.findFirst({ where: { id, tenantId }, include: { items: { orderBy: { position: "asc" } } } });
  if (!quote) throw new QuoteNotFoundError(id);
  if (quote.status === "DRAFT") throw quoteStateError("DRAFT", "revised", "A draft changes as it is: edit it.");
  const phases = phasesOf(quote.phases, quote.items);
  return createDraft(
    tenantId,
    {
      patientId: quote.patientId,
      clinicId: quote.clinicId,
      doctorId: quote.doctorId ?? undefined,
      language: quote.language === "ar" ? "ar" : "en",
      title: quote.title ?? undefined,
      note: quote.note ?? undefined,
      phases,
    },
    actor,
    { revisionOf: { id: quote.id, items: quote.items }, now: opts.now },
  );
}

// ── The patient's link ───────────────────────────────────────────────────────

/** The quote as the patient's page shows it: no internal notes, reasons or procedure links. */
export function toPublicQuote(quote: QuoteDTO): PublicQuoteDTO {
  const { revisionOf: _r, revisions: _v, declineReason: _d, withdrawnReason: _w, items, ...rest } = quote;
  return { ...rest, items: items.map(({ procedure: _p, discountReason: _dr, discountNote: _dn, ...item }) => item) };
}

async function resolveToken(token: string): Promise<{ id: string; tenantId: string } | null> {
  if (!looksLikeToken(token)) return null;
  const found = await systemDb.quote.findUnique({ where: { shareTokenHash: hashToken(token, QUOTE_PURPOSE) }, select: { id: true, tenantId: true, status: true } });
  if (!found || found.status === "DRAFT") return null;
  return found;
}

/** The quote behind a patient's link, or null. Public: the token is the only key. */
export async function quoteByToken(token: string): Promise<PublicQuoteDTO | null> {
  const found = await resolveToken(token);
  if (!found) return null;
  return withTenant(found.tenantId, async () => toPublicQuote(await load(found.tenantId, found.id)));
}

export const PublicAnswerInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), itemIds: z.unknown(), name: z.unknown(), signature: z.unknown(), agree: z.unknown() }),
  z.object({ action: z.literal("decline"), reason: z.unknown().optional() }),
]);

/** The patient's answer from the link: accept (items, name, signature) or decline. Null when the link does not work. */
export async function answerByToken(token: string, raw: unknown, meta: { ip?: string | null } = {}): Promise<PublicQuoteDTO | null> {
  const found = await resolveToken(token);
  if (!found) return null;
  const answer = PublicAnswerInput.parse(raw);
  return withTenant(found.tenantId, async () => {
    const actor: Actor = { ip: meta.ip ?? null };
    const { action, ...body } = answer;
    const quote = action === "accept" ? await acceptQuote(found.tenantId, found.id, body, "link", actor) : await declineQuote(found.tenantId, found.id, body, "link", actor);
    return toPublicQuote(quote);
  });
}

/** The discount reasons as the patient's copy never shows them, for the clinic's own views. */
export function discountReasonLabel(reason: string | null, note: string | null): string | null {
  if (!reason) return null;
  if (reason === "OTHER") return note ?? DISCOUNT_REASON_LABELS.OTHER;
  return DISCOUNT_REASON_LABELS[reason as DiscountReasonValue] ?? reason;
}

/** For the patient record: the patient's quotes, newest first. */
export async function patientQuotes(tenantId: string, patientId: string) {
  return listQuotes(tenantId, { patientId, pageSize: 20 });
}

