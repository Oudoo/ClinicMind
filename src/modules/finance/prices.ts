import { Prisma, type PriceUnit } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantClinic, TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { requireTenantTreatment } from "@/modules/treatments/service";
import { MAX_AMOUNT, PRICE_CATEGORIES, PRICE_UNITS, type PriceCategoryValue, type PriceUnitValue } from "./constants";
import { FinanceError } from "./errors";

/**
 * The clinic's price list (Phase 2, finance part 1).
 *
 * Every billable item has a fixed code (printed on invoices), a name, a
 * category, a unit (per visit, session, area, unit such as a graft or a
 * syringe, tooth or arch, or a course package of N sessions of another item)
 * and the treatment it bills for. Prices are rows from a day on: the newest
 * one on or before a day applies, a branch's own before the clinic-wide one.
 * A price in force is never edited; a change is a new row from today or a
 * later day, so whatever was charged keeps its price. A change scheduled for
 * a later day can be replaced or withdrawn until it takes effect.
 */

type Client = Prisma.TransactionClient;

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class PriceItemNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `price item ${id} not found in tenant`, { entity: "price_item" });
    this.name = "PriceItemNotFoundError";
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

const CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const zCode = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(CODE, "2 to 20 capital letters, digits or dashes, e.g. LSR-FACE"));
const zMoney = z.coerce.number().int("Whole EGP").min(0, "Whole EGP").max(MAX_AMOUNT);
const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const zClearable = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(max).nullable().optional());

function checkUnitFields(v: { unit?: PriceUnitValue; unitLabel?: string | null; sessions?: number | null; sessionItemId?: string | null }, ctx: z.RefinementCtx) {
  if (v.unit === "PACKAGE") {
    if (!v.sessions) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessions"], message: "How many sessions the course holds" });
    if (!v.sessionItemId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessionItemId"], message: "Which item each session is" });
  } else if (v.unit !== undefined && (v.sessions || v.sessionItemId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sessions"], message: "Only a course package has sessions" });
  }
  if (v.unitLabel && v.unit !== undefined && v.unit !== "UNIT") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unitLabel"], message: "Only a per-unit price names its unit" });
  }
}

export const PriceItemInput = z
  .object({
    code: zCode,
    name: zText(120).min(2, "Name the item"),
    category: z.enum(PRICE_CATEGORIES),
    unit: z.enum(PRICE_UNITS).default("SESSION"),
    unitLabel: z.preprocess(blank, zOptionalText(30)),
    treatmentId: zText(64).min(1, "Choose the treatment it bills for"),
    sessions: z.preprocess(blank, z.coerce.number().int().min(2, "At least 2 sessions").max(100).optional()),
    sessionItemId: z.preprocess(blank, zOptionalText(64)),
    /** The first price, clinic-wide. */
    price: zMoney,
    /** Materials used for one unit of it, in EGP: taken off the work before a doctor's share. */
    materialCost: z.preprocess(blank, zMoney.optional()),
    /** From this day on the clinic clock (today when left out). */
    effectiveFrom: z.preprocess(blank, zDateKey.optional()),
    sortOrder: z.preprocess(blank, z.coerce.number().int().min(0).max(100_000).optional()),
  })
  .superRefine(checkUnitFields);

export const PriceItemUpdateInput = z
  .object({
    name: zText(120).min(2, "Name the item").optional(),
    category: z.enum(PRICE_CATEGORIES).optional(),
    unit: z.enum(PRICE_UNITS).optional(),
    unitLabel: zClearable(30),
    treatmentId: zText(64).min(1).optional(),
    sessions: z.preprocess((v) => (v === "" ? null : v), z.coerce.number().int().min(2).max(100).nullable().optional()),
    sessionItemId: zClearable(64),
    active: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
    materialCost: z.preprocess(blank, zMoney.optional()),
  })
  .superRefine(checkUnitFields);

export const PriceScheduleInput = z.object({
  amount: zMoney,
  /** The first day the price applies (clinic clock): today or later. */
  effectiveFrom: zDateKey,
  /** A branch for a price of its own; empty for the clinic-wide price. */
  clinicId: z.preprocess(blank, zOptionalText(64)),
});

export const PriceListQuery = z.object({
  q: z.preprocess(blank, zOptionalText(80)),
  category: z.preprocess(blank, z.enum(PRICE_CATEGORIES).optional()),
  /** Prices as of this day (default today). */
  at: z.preprocess(blank, zDateKey.optional()),
  clinicId: z.preprocess(blank, zOptionalText(64)),
  includeInactive: z.preprocess((v) => v === true || v === "1" || v === "true", z.boolean()).default(false),
});

// ── Price lookup ─────────────────────────────────────────────────────────────

interface PriceRow {
  id: string;
  clinicId: string | null;
  amount: number;
  effectiveFrom: Date;
  createdAt: Date;
}

const newestFirst = (a: PriceRow, b: PriceRow) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime();

/** The row in force at `at` for a branch: its own newest, else the clinic-wide newest. */
export function priceInForce(rows: readonly PriceRow[], at: Date, clinicId: string | null = null): PriceRow | null {
  const due = rows.filter((r) => r.effectiveFrom.getTime() <= at.getTime()).sort(newestFirst);
  return (clinicId ? due.find((r) => r.clinicId === clinicId) : undefined) ?? due.find((r) => r.clinicId === null) ?? null;
}

/** The next change for a branch after `at` (its own or the clinic-wide one that would apply to it). */
export function nextPriceChange(rows: readonly PriceRow[], at: Date, clinicId: string | null = null): PriceRow | null {
  const future = rows.filter((r) => r.effectiveFrom.getTime() > at.getTime() && (r.clinicId === null || r.clinicId === clinicId));
  future.sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  for (const r of future) {
    // A clinic-wide change does not reach a branch that keeps a price of its own at that point.
    if (r.clinicId === null && clinicId && priceInForce(rows, r.effectiveFrom, clinicId)?.clinicId === clinicId) continue;
    return r;
  }
  return null;
}

/** The item's price on `at` for a branch (null when it has none yet). */
export async function priceOn(tenantId: string, priceItemId: string, at: Date, clinicId: string | null = null, client: Client = db): Promise<number | null> {
  const rows = await client.priceItemPrice.findMany({
    where: { tenantId, priceItemId, effectiveFrom: { lte: at } },
    select: { id: true, clinicId: true, amount: true, effectiveFrom: true, createdAt: true },
  });
  return priceInForce(rows, at, clinicId)?.amount ?? null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export interface PriceItemDTO {
  id: string;
  code: string;
  name: string;
  category: PriceCategoryValue;
  unit: PriceUnitValue;
  unitLabel: string | null;
  treatment: { id: string; name: string };
  sessions: number | null;
  sessionItem: { id: string; code: string; name: string } | null;
  active: boolean;
  sortOrder: number;
  /** Materials used for one unit, in EGP. */
  materialCost: number;
  /** In force on the day asked for (for the branch asked for), or null. */
  price: number | null;
  priceSince: string | null;
  /** True when that price is the branch's own. */
  branchPrice: boolean;
  next: { amount: number; effectiveFrom: string; clinicId: string | null } | null;
  /** Branches with a price of their own in force. */
  branchPrices: { clinicId: string; amount: number }[];
  /** For a course: the package price against that many single sessions. */
  saving: number | null;
}

const itemInclude = {
  treatment: { select: { id: true, name: true } },
  sessionItem: { select: { id: true, code: true, name: true } },
  prices: { select: { id: true, clinicId: true, amount: true, effectiveFrom: true, createdAt: true } },
} satisfies Prisma.PriceItemInclude;

type ItemRow = Prisma.PriceItemGetPayload<{ include: typeof itemInclude }>;

function toDTO(row: ItemRow, at: Date, clinicId: string | null, timezone: string, byId: Map<string, ItemRow>): PriceItemDTO {
  const current = priceInForce(row.prices, at, clinicId);
  const next = nextPriceChange(row.prices, at, clinicId);
  const branches = [...new Set(row.prices.filter((p) => p.clinicId).map((p) => p.clinicId!))];
  const branchPrices = branches
    .map((b) => ({ clinicId: b, row: row.prices.filter((p) => p.clinicId === b && p.effectiveFrom <= at).sort(newestFirst)[0] }))
    .filter((b): b is { clinicId: string; row: PriceRow } => Boolean(b.row))
    .map((b) => ({ clinicId: b.clinicId, amount: b.row.amount }));
  const single = row.sessionItemId ? byId.get(row.sessionItemId) : undefined;
  const singlePrice = single ? priceInForce(single.prices, at, clinicId)?.amount : undefined;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category as PriceCategoryValue,
    unit: row.unit,
    unitLabel: row.unitLabel,
    treatment: row.treatment,
    sessions: row.sessions,
    sessionItem: row.sessionItem,
    active: row.active,
    sortOrder: row.sortOrder,
    materialCost: row.materialCost,
    price: current?.amount ?? null,
    priceSince: current ? dateKeyInTz(current.effectiveFrom, timezone) : null,
    branchPrice: Boolean(current?.clinicId),
    next: next ? { amount: next.amount, effectiveFrom: dateKeyInTz(next.effectiveFrom, timezone), clinicId: next.clinicId } : null,
    branchPrices,
    saving: row.sessions && singlePrice !== undefined && current ? singlePrice * row.sessions - current.amount : null,
  };
}

/** The price list as of a day (today by default), for a branch or clinic-wide. */
export async function listPriceList(tenantId: string, rawQuery: unknown = {}): Promise<{ items: PriceItemDTO[]; at: string; timezone: string }> {
  const query = PriceListQuery.parse(rawQuery);
  const timezone = await getTenantTimezone(tenantId);
  const at = query.at ? (fromDateKey(query.at, timezone) ?? new Date()) : new Date();
  // The whole day asked for: a price from that day applies to it.
  const asOf = query.at ? new Date(at.getTime() + 86_400_000 - 1) : at;
  if (query.clinicId) await requireTenantClinic(tenantId, query.clinicId);
  const rows = await db.priceItem.findMany({
    where: {
      tenantId,
      ...(query.includeInactive ? {} : { active: true }),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { code: { contains: query.q, mode: "insensitive" } }] }
        : {}),
    },
    include: itemInclude,
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  // Course packages compare with their session item, which a filter may have left out.
  const missing = [...new Set(rows.map((r) => r.sessionItemId).filter((id): id is string => Boolean(id) && !rows.some((r) => r.id === id)))];
  const extra = missing.length ? await db.priceItem.findMany({ where: { tenantId, id: { in: missing } }, include: itemInclude }) : [];
  const byId = new Map([...rows, ...extra].map((r) => [r.id, r]));
  return {
    items: rows.map((r) => toDTO(r, asOf, query.clinicId ?? null, timezone, byId)),
    at: dateKeyInTz(asOf, timezone),
    timezone,
  };
}

export interface PriceHistoryEntry {
  id: string;
  clinicId: string | null;
  amount: number;
  effectiveFrom: string;
  createdAt: string;
  createdBy: string | null;
  /** Not in force yet: can still be replaced or withdrawn. */
  scheduled: boolean;
}

export async function getPriceItem(tenantId: string, id: string): Promise<(PriceItemDTO & { history: PriceHistoryEntry[] }) | null> {
  const row = await db.priceItem.findFirst({ where: { id, tenantId }, include: itemInclude });
  if (!row) return null;
  const timezone = await getTenantTimezone(tenantId);
  const single = row.sessionItemId ? await db.priceItem.findFirst({ where: { id: row.sessionItemId, tenantId }, include: itemInclude }) : null;
  const byId = new Map([row, ...(single ? [single] : [])].map((r) => [r.id, r]));
  const now = new Date();
  const history = await db.priceItemPrice.findMany({ where: { tenantId, priceItemId: id }, orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }] });
  const authorIds = [...new Set(history.map((h) => h.createdById).filter((v): v is string => Boolean(v)))];
  const authors = authorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: authorIds } }, select: { id: true, fullName: true } }) : [];
  const nameOf = new Map(authors.map((a) => [a.id, a.fullName]));
  return {
    ...toDTO(row, now, null, timezone, byId),
    history: history.map((h) => ({
      id: h.id,
      clinicId: h.clinicId,
      amount: h.amount,
      effectiveFrom: dateKeyInTz(h.effectiveFrom, timezone),
      createdAt: h.createdAt.toISOString(),
      createdBy: h.createdById ? (nameOf.get(h.createdById) ?? "Staff") : null,
      scheduled: h.effectiveFrom.getTime() > now.getTime(),
    })),
  };
}

// ── Writing ──────────────────────────────────────────────────────────────────

async function requireItem(tenantId: string, id: string, client: Client = db) {
  const row = await client.priceItem.findFirst({ where: { id, tenantId } });
  if (!row) throw new PriceItemNotFoundError(id);
  return row;
}

/** A course's session item: an item of this clinic that is not itself a course. */
async function requireSessionItem(tenantId: string, id: string, selfId?: string) {
  const item = await db.priceItem.findFirst({ where: { id, tenantId }, select: { id: true, unit: true } });
  if (!item || item.id === selfId) throw new TenantScopeError("price_item", id);
  if (item.unit === "PACKAGE") throw new FinanceError(422, "validation_error", "a course cannot be made of courses", { issues: { fieldErrors: { sessionItemId: ["Choose a single session, not another course"] } } });
}

/** The first moment of a day on the clinic clock; refuses a day before today. */
async function dayFrom(tenantId: string, key: string | undefined): Promise<Date> {
  const timezone = await getTenantTimezone(tenantId);
  const today = startOfDayInTz(new Date(), timezone);
  if (!key) return today;
  const day = fromDateKey(key, timezone);
  if (!day) throw new FinanceError(422, "validation_error", "invalid date", { issues: { fieldErrors: { effectiveFrom: ["Use YYYY-MM-DD"] } } });
  if (day.getTime() < today.getTime()) {
    throw new FinanceError(422, "price_in_the_past", "a price can only change from today on", {
      issues: { fieldErrors: { effectiveFrom: ["From today on: past charges and invoices keep the price they had"] } },
    });
  }
  return day;
}

function itemSnapshot(row: { code: string; name: string; category: string; unit: PriceUnit; unitLabel: string | null; treatmentId: string; sessions: number | null; sessionItemId: string | null; active: boolean; materialCost: number }) {
  return { code: row.code, name: row.name, category: row.category, unit: row.unit, unitLabel: row.unitLabel, treatmentId: row.treatmentId, sessions: row.sessions, sessionItemId: row.sessionItemId, active: row.active, materialCost: row.materialCost };
}

export async function createPriceItem(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<PriceItemDTO & { history: PriceHistoryEntry[] }> {
  const input = PriceItemInput.parse(rawInput);
  await requireTenantTreatment(tenantId, input.treatmentId);
  if (input.sessionItemId) await requireSessionItem(tenantId, input.sessionItemId);
  const effectiveFrom = await dayFrom(tenantId, input.effectiveFrom);
  let created: { id: string };
  try {
    created = await db.$transaction(async (tx) => {
      const item = await tx.priceItem.create({
        data: {
          tenantId,
          code: input.code,
          name: input.name,
          category: input.category,
          unit: input.unit,
          unitLabel: input.unit === "UNIT" ? (input.unitLabel ?? null) : null,
          treatmentId: input.treatmentId,
          sessions: input.unit === "PACKAGE" ? (input.sessions ?? null) : null,
          sessionItemId: input.unit === "PACKAGE" ? (input.sessionItemId ?? null) : null,
          sortOrder: input.sortOrder ?? 0,
          materialCost: input.materialCost ?? 0,
        },
        select: { id: true },
      });
      await tx.priceItemPrice.create({ data: { tenantId, priceItemId: item.id, amount: input.price, effectiveFrom, createdById: actor.id ?? null } });
      return item;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new FinanceError(409, "code_taken", `code ${input.code} is already used`, { issues: { fieldErrors: { code: [`${input.code} is already on the price list`] } } });
    }
    throw err;
  }
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "price.item.create",
    entity: "PriceItem",
    entityId: created.id,
    after: { code: input.code, name: input.name, category: input.category, unit: input.unit, price: input.price, effectiveFrom: input.effectiveFrom ?? "today" },
  });
  return (await getPriceItem(tenantId, created.id))!;
}

/** Name, category, unit, treatment, course and whether it is offered; the code stays as it is. */
export async function updatePriceItem(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = PriceItemUpdateInput.parse(rawInput);
  const before = await requireItem(tenantId, id);
  if (input.treatmentId) await requireTenantTreatment(tenantId, input.treatmentId);
  const unit = input.unit ?? before.unit;
  const sessions = input.sessions === undefined ? before.sessions : input.sessions;
  const sessionItemId = input.sessionItemId === undefined ? before.sessionItemId : input.sessionItemId;
  const unitLabel = input.unitLabel === undefined ? before.unitLabel : input.unitLabel;
  // The combination must still make sense once merged with what is stored.
  const merged = PriceItemUpdateInput.safeParse({ unit, sessions, sessionItemId, unitLabel: unit === "UNIT" ? unitLabel : null });
  if (!merged.success) throw merged.error;
  if (unit === "PACKAGE" && sessionItemId) await requireSessionItem(tenantId, sessionItemId, id);
  const after = await db.priceItem.update({
    where: { id },
    data: {
      name: input.name,
      category: input.category,
      unit,
      unitLabel: unit === "UNIT" ? unitLabel : null,
      treatmentId: input.treatmentId,
      sessions: unit === "PACKAGE" ? sessions : null,
      sessionItemId: unit === "PACKAGE" ? sessionItemId : null,
      active: input.active,
      sortOrder: input.sortOrder,
      materialCost: input.materialCost,
    },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "price.item.update",
    entity: "PriceItem",
    entityId: id,
    before: itemSnapshot(before),
    after: itemSnapshot(after),
  });
  return (await getPriceItem(tenantId, id))!;
}

/**
 * A new price from a day (today or later), clinic-wide or for one branch.
 * A change already scheduled for that same later day is replaced; a price
 * already in force is never touched (today's change adds a newer row).
 */
export async function schedulePrice(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = PriceScheduleInput.parse(rawInput);
  const item = await requireItem(tenantId, id);
  if (input.clinicId) await requireTenantClinic(tenantId, input.clinicId);
  const effectiveFrom = await dayFrom(tenantId, input.effectiveFrom);
  const now = new Date();
  const replaced = await db.$transaction(async (tx) => {
    const gone =
      effectiveFrom.getTime() > now.getTime()
        ? await tx.priceItemPrice.deleteMany({ where: { tenantId, priceItemId: id, clinicId: input.clinicId ?? null, effectiveFrom } })
        : { count: 0 };
    await tx.priceItemPrice.create({
      data: { tenantId, priceItemId: id, clinicId: input.clinicId ?? null, amount: input.amount, effectiveFrom, createdById: actor.id ?? null },
    });
    return gone.count;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "price.schedule",
    entity: "PriceItem",
    entityId: id,
    after: { code: item.code, amount: input.amount, effectiveFrom: input.effectiveFrom, clinicId: input.clinicId ?? null, replacedScheduled: replaced },
  });
  return (await getPriceItem(tenantId, id))!;
}

/** Withdraw a change that has not taken effect yet. */
export async function withdrawScheduledPrice(tenantId: string, id: string, priceId: string, actor: Actor = {}) {
  const item = await requireItem(tenantId, id);
  const row = await db.priceItemPrice.findFirst({ where: { id: priceId, tenantId, priceItemId: id } });
  if (!row) throw new FinanceError(404, "not_found", `price ${priceId} not found`, { entity: "price" });
  if (row.effectiveFrom.getTime() <= Date.now()) {
    throw new FinanceError(409, "price_in_force", "a price in force stays in the history; schedule a new one instead");
  }
  await db.priceItemPrice.delete({ where: { id: priceId } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "price.withdraw",
    entity: "PriceItem",
    entityId: id,
    before: { code: item.code, amount: row.amount, effectiveFrom: row.effectiveFrom.toISOString(), clinicId: row.clinicId },
  });
  return (await getPriceItem(tenantId, id))!;
}
