import { Prisma, type Supplier, type UserRole } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { parseFilePayload, UploadError, type FileUpload } from "@/lib/uploads";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { assertDayOpen, branchTimezone, openShiftOf } from "./cash";
import { MAX_AMOUNT, METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "./constants";
import { defaultClinicId } from "./documents";
import { isMonthKey, monthLabel, monthOfKey, shiftMonth } from "./doctor-pay-calc";
import { FinanceError } from "./errors";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_STATUS_LABELS,
  isOwnerOnlyCategory,
  MAX_EXPENSE_FILE_BYTES,
  MAX_EXPENSE_FILES,
  OWNER_ONLY_CATEGORIES,
  RECURRING_EVERY,
  type ExpenseCategoryValue,
  type ExpenseStatusValue,
  type ExpenseView,
} from "./expense-constants";

/**
 * Expenses and suppliers: what the clinic spends, under a fixed list of
 * categories, for a branch, from a supplier or not.
 *
 * An expense is a bill to pay by a day (the supplier's, the landlord's) or
 * money spent at once (water for the waiting room); it is paid in one payment
 * or several, never past its amount. Cash paid at the desk today comes out of
 * the cashier's open shift: the drawer's cash expected goes down by it, and a
 * day signed off keeps it. A receipt's photo or PDF goes with it. Nothing is
 * deleted: an expense or a payment entered by mistake is voided by the owner
 * with the reason (an expense's payments with it), and the database refuses
 * anything else.
 *
 * A recurring expense (the rent, the internet, a service contract) makes its
 * bill on its day every month or every few months, at the amount it has then:
 * the background job `recurring-expenses` does it, once for each month.
 *
 * Salaries are the owner's: no one else records them or sees them, in the
 * lists or in the totals.
 */

type Tx = Prisma.TransactionClient;
export type ExpenseActor = { id?: string | null; email?: string | null; ip?: string | null; role?: UserRole | null };

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zMonth = z.string().trim().refine(isMonthKey, "Use YYYY-MM");
const zMoney = z.number().int("Whole EGP").positive("More than zero").max(MAX_AMOUNT, "Too large");
const zEmail = zOptionalText(160).refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Not an e-mail address");

/** A day key as a date column holds it (midnight UTC), and back. */
const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const addDaysKey = (key: string, days: number) => keyOf(new Date(asDate(key).getTime() + days * 86_400_000));
const pad = (n: number) => String(n).padStart(2, "0");

export const SupplierInput = z.object({
  name: zText(120).min(2, "The supplier's name"),
  category: z.enum(EXPENSE_CATEGORIES).default("OTHER"),
  contactName: zOptionalText(120),
  phone: zOptionalText(40),
  email: zEmail,
  notes: zOptionalText(500),
  /** No longer used: kept with its bills, offered no more (edit only). */
  archived: z.boolean().optional(),
});

const SupplierChoice = {
  /** One from the list… */
  supplierId: zOptionalText(64),
  /** …or a new one by its name (found by it when it exists). */
  supplierName: zOptionalText(120),
};

const PaidNow = z.object({
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  /** Cash out of the cashier's open shift; otherwise paid from elsewhere (the bank, a card, the owner's pocket). */
  fromDrawer: z.boolean().default(false),
  reference: zOptionalText(120),
});

export const ExpenseInput = z
  .object({
    /** The branch it is for (the cashier's, else the first). */
    clinicId: zOptionalText(64),
    ...SupplierChoice,
    category: z.enum(EXPENSE_CATEGORIES),
    description: zText(200).min(2, "Say what it is for"),
    amount: zMoney,
    /** The day of the bill or of the spending (today when left out). */
    billedOn: zDayKey.optional(),
    /** The day it is to be paid by; left out for money spent at once. */
    dueOn: zDayKey.optional(),
    reference: zOptionalText(120),
    note: zOptionalText(500),
    /** Paid in full now, on its day. Left out: a bill to pay later. */
    paid: PaidNow.optional(),
    /** Photos or PDFs of the bill or the receipt (`[{ name, type, data }]`, data in base64). */
    files: z.array(z.unknown()).max(MAX_EXPENSE_FILES, `At most ${MAX_EXPENSE_FILES} files`).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.supplierId && v.supplierName) ctx.addIssue({ code: "custom", path: ["supplierName"], message: "A supplier from the list, or a new name" });
    if (v.dueOn && v.billedOn && v.dueOn < v.billedOn) ctx.addIssue({ code: "custom", path: ["dueOn"], message: "Not before the day of the bill" });
    if (v.paid?.fromDrawer && v.paid.method !== "CASH") ctx.addIssue({ code: "custom", path: ["paid"], message: "Only cash comes out of the drawer" });
  });

export const ExpenseEdit = z
  .object({
    ...SupplierChoice,
    category: z.enum(EXPENSE_CATEGORIES),
    description: zText(200).min(2, "Say what it is for"),
    amount: zMoney,
    billedOn: zDayKey,
    dueOn: zDayKey.optional(),
    reference: zOptionalText(120),
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.supplierId && v.supplierName) ctx.addIssue({ code: "custom", path: ["supplierName"], message: "A supplier from the list, or a new name" });
    if (v.dueOn && v.dueOn < v.billedOn) ctx.addIssue({ code: "custom", path: ["dueOn"], message: "Not before the day of the bill" });
  });

export const ExpensePaymentInput = z
  .object({
    amount: zMoney,
    method: z.enum(PAYMENT_METHODS).default("CASH"),
    /** The day it was paid (today when left out). */
    paidOn: zDayKey.optional(),
    fromDrawer: z.boolean().default(false),
    reference: zOptionalText(120),
    note: zOptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.fromDrawer && v.method !== "CASH") ctx.addIssue({ code: "custom", path: ["fromDrawer"], message: "Only cash comes out of the drawer" });
  });

export const ExpenseVoidInput = z.object({ reason: zText(300).min(3, "Say why, in a few words") });

export const RecurringInput = z
  .object({
    clinicId: zOptionalText(64),
    ...SupplierChoice,
    category: z.enum(EXPENSE_CATEGORIES),
    description: zText(200).min(2, "Say what it is for"),
    amount: zMoney,
    everyMonths: z
      .number()
      .int()
      .refine((n) => (RECURRING_EVERY as readonly number[]).includes(n), "Every 1, 2, 3, 6 or 12 months")
      .default(1),
    dayOfMonth: z.number().int().min(1, "1 to 28").max(28, "1 to 28: every month has them"),
    dueDays: z.number().int().min(0, "0 to 90 days").max(90, "0 to 90 days").default(0),
    /** Its first month (YYYY-MM): from a year back to a year ahead. */
    startMonth: zMonth,
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.supplierId && v.supplierName) ctx.addIssue({ code: "custom", path: ["supplierName"], message: "A supplier from the list, or a new name" });
  });

export const RecurringEdit = z
  .object({
    ...SupplierChoice,
    category: z.enum(EXPENSE_CATEGORIES),
    description: zText(200).min(2, "Say what it is for"),
    amount: zMoney,
    dueDays: z.number().int().min(0, "0 to 90 days").max(90, "0 to 90 days").default(0),
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.supplierId && v.supplierName) ctx.addIssue({ code: "custom", path: ["supplierName"], message: "A supplier from the list, or a new name" });
  });

export const RecurringStopInput = z.object({ reason: zText(300).min(3, "Say why, in a few words") });

export const ExpenseListQuery = z.object({
  /** Still to pay; a month's; all of them (newest first); voided. */
  view: z.enum(["due", "month", "all", "voided"]).default("due"),
  month: zMonth.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  supplierId: zOptionalText(64),
  q: zOptionalText(120),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export class ExpenseNotFoundError extends FinanceError {
  constructor(id: string, entity = "expense") {
    super(404, "not_found", `${entity} ${id} not found in tenant`, { entity });
    this.name = "ExpenseNotFoundError";
  }
}

const ownerOnlyError = () =>
  new FinanceError(403, "owner_only", "salaries are the owner's", { message: "Salaries are recorded and seen by the clinic owner only." });

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface SupplierDTO {
  id: string;
  name: string;
  category: ExpenseCategoryValue;
  categoryLabel: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  archived: boolean;
  /** Its bills not paid in full, and what is owed on them. */
  openBills: number;
  owed: number;
  /** Billed since the 1st of January. */
  billedThisYear: number;
  lastBilledOn: string | null;
}

export interface ExpensePaymentDTO {
  id: string;
  amount: number;
  method: PaymentMethodValue;
  methodLabel: string;
  paidAt: string;
  reference: string | null;
  /** Paid out of a cash drawer (a shift). */
  fromDrawer: boolean;
  paidBy: string | null;
  note: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

export interface ExpenseFileDTO {
  id: string;
  name: string | null;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url: string;
}

export interface ExpenseDTO {
  id: string;
  clinic: { id: string; name: string };
  supplier: { id: string; name: string } | null;
  category: ExpenseCategoryValue;
  categoryLabel: string;
  description: string;
  reference: string | null;
  billedOn: string;
  dueOn: string | null;
  amount: number;
  paid: number;
  owed: number;
  status: ExpenseStatusValue;
  statusLabel: string;
  /** Owed past its day. */
  overdue: boolean;
  daysLate: number | null;
  recurring: { id: string; description: string; period: string; periodLabel: string } | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  payments: ExpensePaymentDTO[];
  files: ExpenseFileDTO[];
}

export interface RecurringDTO {
  id: string;
  clinic: { id: string; name: string };
  supplier: { id: string; name: string } | null;
  category: ExpenseCategoryValue;
  categoryLabel: string;
  description: string;
  amount: number;
  everyMonths: number;
  dayOfMonth: number;
  dueDays: number;
  startMonth: string;
  note: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  /** The next bill's day (YYYY-MM-DD); null once stopped. */
  nextOn: string | null;
  /** The bills it made, and the last one's day. */
  made: number;
  lastOn: string | null;
}

export interface ExpenseKpis {
  timezone: string;
  today: string;
  month: string;
  /** Billed or spent this month. */
  spentThisMonth: number;
  toPay: { amount: number; bills: number };
  overdue: { amount: number; bills: number };
  /** Paid towards expenses this month. */
  paidThisMonth: number;
  /** This month by category, the largest first. */
  byCategory: { category: ExpenseCategoryValue; label: string; amount: number }[];
}

export interface ExpenseList {
  view: "due" | "month" | "all" | "voided";
  month: string;
  monthLabel: string;
  timezone: string;
  today: string;
  rows: ExpenseDTO[];
  total: number;
  page: number;
  pageSize: number;
  /** The month's total in the list, and by category, the largest first (the month view). */
  amount: number;
  byCategory: { category: ExpenseCategoryValue; label: string; amount: number }[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const isOwner = (role: UserRole | null | undefined) => !!role && can(role, "tenant:manage");

/** What a viewer may see: salaries only for the owner. */
const visibleTo = (role: UserRole | null | undefined): Prisma.ExpenseWhereInput => (isOwner(role) ? {} : { category: { notIn: [...OWNER_ONLY_CATEGORIES] } });

function assertMayRecord(category: string, actor: ExpenseActor) {
  if (isOwnerOnlyCategory(category) && !isOwner(actor.role)) throw ownerOnlyError();
}

/** A day key on the clinic clock that must be a real day, not ahead of today. */
function realDay(key: string, timezone: string, path: string, today: string, opts: { future?: boolean } = {}): string {
  if (!fromDateKey(key, timezone)) throw new z.ZodError([{ code: "custom", path: [path], message: "Not a real date" }]);
  if (!opts.future && key > today) throw new z.ZodError([{ code: "custom", path: [path], message: "Not a day ahead" }]);
  return key;
}

/** The moment money dated `key` was paid: now for today, else noon of that day on the clinic clock. */
function momentOf(key: string, timezone: string, now: Date): Date {
  if (key === dateKeyInTz(now, timezone)) return now;
  return new Date(fromDateKey(key, timezone)!.getTime() + 12 * 3_600_000);
}

async function requireClinic(tx: Tx, tenantId: string, clinicId: string | undefined, actorId: string | null | undefined): Promise<{ id: string; name: string }> {
  const fromShift = !clinicId && actorId ? (await openShiftOf(tx, tenantId, actorId))?.clinicId : undefined;
  const id = clinicId ?? fromShift ?? (await defaultClinicId(tx, tenantId));
  if (!id) throw new FinanceError(409, "no_branch", "the clinic has no branch", { message: "Add a branch (a location) to the clinic first." });
  const clinic = await tx.clinic.findFirst({ where: { id, tenantId, deletedAt: null }, select: { id: true, name: true } });
  if (!clinic) throw new TenantScopeError("clinic", id);
  return clinic;
}

/** The supplier chosen, or found or made by its name; null for none. */
async function resolveSupplier(
  tx: Tx,
  tenantId: string,
  choice: { supplierId?: string; supplierName?: string },
  category: ExpenseCategoryValue,
  actor: ExpenseActor,
): Promise<{ id: string; name: string } | null> {
  if (choice.supplierId) {
    const s = await tx.supplier.findFirst({ where: { id: choice.supplierId, tenantId }, select: { id: true, name: true } });
    if (!s) throw new TenantScopeError("supplier", choice.supplierId);
    return s;
  }
  if (!choice.supplierName) return null;
  const name = choice.supplierName.replace(/\s+/g, " ");
  const found = await tx.supplier.findFirst({ where: { tenantId, name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } });
  if (found) return found;
  const made = await tx.supplier.create({ data: { tenantId, name, category, createdById: actor.id ?? null }, select: { id: true, name: true } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "supplier.create", entity: "Supplier", entityId: made.id, after: { name, category } });
  return made;
}

/** The cashier's drawer for cash paid out today: their open shift, opened today, its day not signed off. */
async function drawerFor(tx: Tx, tenantId: string, actorId: string | null | undefined, paidOn: string | undefined, now: Date): Promise<{ shiftId: string; clinicId: string }> {
  const shift = actorId ? await openShiftOf(tx, tenantId, actorId) : null;
  if (!shift) throw new FinanceError(409, "no_shift", "cash out of the drawer needs an open shift", { message: "Open your shift first (Cash drawer): cash paid out of the drawer comes out of it." });
  const tz = await branchTimezone(tx, tenantId, shift.clinicId);
  const today = dateKeyInTz(now, tz);
  if (paidOn && paidOn !== today) {
    throw new FinanceError(409, "drawer_today", "only today's cash comes out of the drawer", { message: "Only today's cash comes out of the drawer: for an earlier day, record it as paid from elsewhere." });
  }
  const opened = dateKeyInTz(shift.openedAt, tz);
  if (opened < today) {
    throw new FinanceError(409, "stale_shift", "the cashier's open shift is from an earlier day", { day: opened, message: `Your shift from ${opened} is still open: close it (Cash drawer), then open today's.` });
  }
  await assertDayOpen(tx, tenantId, shift.clinicId, now, "no cash is paid out on it.");
  return { shiftId: shift.id, clinicId: shift.clinicId };
}

function filesFromPayload(raw: unknown): FileUpload[] {
  try {
    return parseFilePayload(raw, { max: MAX_EXPENSE_FILES, maxBytes: MAX_EXPENSE_FILE_BYTES });
  } catch (err) {
    if (err instanceof UploadError) throw new FinanceError(422, err.code, err.message, { message: err.message });
    throw err;
  }
}

async function storeFiles(tx: Tx, tenantId: string, expenseId: string, files: FileUpload[], actor: ExpenseActor, now: Date) {
  if (!files.length) return;
  const have = await tx.expenseFile.count({ where: { tenantId, expenseId } });
  if (have + files.length > MAX_EXPENSE_FILES) {
    throw new FinanceError(422, "too_many_files", "too many files on the expense", { message: `At most ${MAX_EXPENSE_FILES} files on one expense.` });
  }
  for (const f of files) {
    const blob = await tx.fileBlob.create({ data: { tenantId, mimeType: f.mimeType, sizeBytes: f.bytes.length, bytes: f.bytes, createdAt: now }, select: { id: true } });
    await tx.expenseFile.create({ data: { tenantId, expenseId, blobId: blob.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.bytes.length, createdById: actor.id ?? null, createdAt: now } });
  }
}

const expenseInclude = {
  clinic: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  recurring: { select: { id: true, description: true } },
  payments: { orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }] },
  files: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true } },
} satisfies Prisma.ExpenseInclude;

type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

function toDTO(e: ExpenseRow, today: string, names: Map<string, string>): ExpenseDTO {
  const live = e.payments.filter((p) => !p.voidedAt);
  const paid = live.reduce((s, p) => s + p.amount, 0);
  const owed = e.voidedAt ? 0 : Math.max(0, e.amount - paid);
  const status: ExpenseStatusValue = e.voidedAt ? "VOID" : owed === 0 ? "PAID" : paid > 0 ? "PART_PAID" : "OPEN";
  const dueOn = e.dueOn ? keyOf(e.dueOn) : null;
  const overdue = owed > 0 && !!dueOn && dueOn < today;
  return {
    id: e.id,
    clinic: e.clinic,
    supplier: e.supplier,
    category: e.category,
    categoryLabel: EXPENSE_CATEGORY_LABELS[e.category],
    description: e.description,
    reference: e.reference,
    billedOn: keyOf(e.billedOn),
    dueOn,
    amount: e.amount,
    paid,
    owed,
    status,
    statusLabel: EXPENSE_STATUS_LABELS[status],
    overdue,
    daysLate: overdue ? Math.round((asDate(today).getTime() - asDate(dueOn!).getTime()) / 86_400_000) : null,
    recurring: e.recurring && e.period ? { id: e.recurring.id, description: e.recurring.description, period: e.period, periodLabel: monthLabel(e.period) } : null,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
    createdBy: e.createdById ? (names.get(e.createdById) ?? null) : null,
    voidedAt: e.voidedAt?.toISOString() ?? null,
    voidReason: e.voidReason,
    payments: e.payments.map((p) => ({
      id: p.id,
      amount: p.amount,
      method: p.method,
      methodLabel: METHOD_LABELS[p.method],
      paidAt: p.paidAt.toISOString(),
      reference: p.reference,
      fromDrawer: !!p.shiftId,
      paidBy: p.createdById ? (names.get(p.createdById) ?? null) : null,
      note: p.note,
      voidedAt: p.voidedAt?.toISOString() ?? null,
      voidReason: p.voidReason,
    })),
    files: e.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, createdAt: f.createdAt.toISOString(), url: `/api/expense-files/${f.id}` })),
  };
}

async function toDTOs(rows: ExpenseRow[], today: string): Promise<ExpenseDTO[]> {
  const names = await namesOf(rows.flatMap((e) => [e.createdById, ...e.payments.map((p) => p.createdById)]));
  return rows.map((e) => toDTO(e, today, names));
}

async function loadExpense(client: Tx | typeof db, tenantId: string, id: string, role: UserRole | null | undefined): Promise<ExpenseRow> {
  const row = await client.expense.findFirst({ where: { id, tenantId, ...visibleTo(role) }, include: expenseInclude });
  if (!row) throw new ExpenseNotFoundError(id);
  return row;
}

async function todayOf(tenantId: string, now: Date) {
  const timezone = await getTenantTimezone(tenantId);
  return { timezone, today: dateKeyInTz(now, timezone) };
}

// ── Suppliers ────────────────────────────────────────────────────────────────

/** The suppliers, by name, with what is owed to each and what each billed this year (salaries only for the owner). */
export async function listSuppliers(tenantId: string, opts: { role?: UserRole | null; includeArchived?: boolean; q?: string; now?: Date } = {}): Promise<SupplierDTO[]> {
  const { today } = await todayOf(tenantId, opts.now ?? new Date());
  const suppliers = await db.supplier.findMany({
    where: { tenantId, ...(opts.includeArchived ? {} : { archivedAt: null }), ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" } } : {}) },
    orderBy: [{ name: "asc" }],
  });
  return withBalances(tenantId, suppliers, today, opts.role);
}

async function withBalances(tenantId: string, suppliers: Supplier[], today: string, role: UserRole | null | undefined): Promise<SupplierDTO[]> {
  const ids = suppliers.map((s) => s.id);
  const bills = ids.length
    ? await db.expense.findMany({
        where: { tenantId, supplierId: { in: ids }, voidedAt: null, ...visibleTo(role) },
        select: { supplierId: true, amount: true, billedOn: true, payments: { where: { voidedAt: null }, select: { amount: true } } },
      })
    : [];
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const by = new Map<string, { openBills: number; owed: number; billedThisYear: number; lastBilledOn: string | null }>();
  for (const b of bills) {
    const t = by.get(b.supplierId!) ?? { openBills: 0, owed: 0, billedThisYear: 0, lastBilledOn: null };
    const owed = b.amount - b.payments.reduce((s, p) => s + p.amount, 0);
    if (owed > 0) {
      t.openBills += 1;
      t.owed += owed;
    }
    const day = keyOf(b.billedOn);
    if (day >= yearStart) t.billedThisYear += b.amount;
    if (!t.lastBilledOn || day > t.lastBilledOn) t.lastBilledOn = day;
    by.set(b.supplierId!, t);
  }
  return suppliers.map((s) => {
    const t = by.get(s.id) ?? { openBills: 0, owed: 0, billedThisYear: 0, lastBilledOn: null };
    return {
      id: s.id,
      name: s.name,
      category: s.category,
      categoryLabel: EXPENSE_CATEGORY_LABELS[s.category],
      contactName: s.contactName,
      phone: s.phone,
      email: s.email,
      notes: s.notes,
      archived: !!s.archivedAt,
      ...t,
    };
  });
}

export async function getSupplier(tenantId: string, id: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<SupplierDTO> {
  const s = await db.supplier.findFirst({ where: { id, tenantId } });
  if (!s) throw new TenantScopeError("supplier", id);
  const { today } = await todayOf(tenantId, opts.now ?? new Date());
  return (await withBalances(tenantId, [s], today, opts.role))[0]!;
}

const duplicateSupplier = () => new FinanceError(409, "duplicate", "a supplier of that name exists", { message: "A supplier of that name exists already." });

export async function createSupplier(tenantId: string, rawInput: unknown, actor: ExpenseActor = {}): Promise<SupplierDTO> {
  const input = SupplierInput.parse(rawInput);
  const name = input.name.replace(/\s+/g, " ");
  if (await db.supplier.findFirst({ where: { tenantId, name: { equals: name, mode: "insensitive" } }, select: { id: true } })) throw duplicateSupplier();
  let made;
  try {
    made = await db.supplier.create({
      data: { tenantId, name, category: input.category, contactName: input.contactName ?? null, phone: input.phone ?? null, email: input.email ?? null, notes: input.notes ?? null, createdById: actor.id ?? null },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw duplicateSupplier();
    throw err;
  }
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "supplier.create", entity: "Supplier", entityId: made.id, after: { name, category: input.category } });
  return getSupplier(tenantId, made.id, { role: actor.role });
}

/** Save a supplier's details (all of them, as the form holds them), and archive it or bring it back. */
export async function updateSupplier(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}): Promise<SupplierDTO> {
  const input = SupplierInput.parse(rawInput);
  const before = await db.supplier.findFirst({ where: { id, tenantId } });
  if (!before) throw new TenantScopeError("supplier", id);
  const name = input.name.replace(/\s+/g, " ");
  const clash = await db.supplier.findFirst({ where: { tenantId, id: { not: id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (clash) throw duplicateSupplier();
  const archivedAt = input.archived === undefined ? before.archivedAt : input.archived ? (before.archivedAt ?? new Date()) : null;
  try {
    await db.supplier.update({
      where: { id },
      data: { name, category: input.category, contactName: input.contactName ?? null, phone: input.phone ?? null, email: input.email ?? null, notes: input.notes ?? null, archivedAt },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw duplicateSupplier();
    throw err;
  }
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "supplier.update",
    entity: "Supplier",
    entityId: id,
    before: { name: before.name, category: before.category, archived: !!before.archivedAt },
    after: { name, category: input.category, archived: !!archivedAt },
  });
  return getSupplier(tenantId, id, { role: actor.role });
}

// ── Expenses ─────────────────────────────────────────────────────────────────

/** Record a bill to pay, or money spent (paid now, in full): with its supplier, its receipt's photos and, for cash at the desk today, out of the drawer. */
export async function createExpense(tenantId: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const input = ExpenseInput.parse(rawInput);
  assertMayRecord(input.category, actor);
  const now = opts.now ?? new Date();
  const { timezone, today } = await todayOf(tenantId, now);
  const billedOn = input.billedOn ? realDay(input.billedOn, timezone, "billedOn", today) : today;
  const dueOn = input.paid ? undefined : input.dueOn ? realDay(input.dueOn, timezone, "dueOn", today, { future: true }) : undefined;
  if (dueOn && dueOn < billedOn) throw new z.ZodError([{ code: "custom", path: ["dueOn"], message: "Not before the day of the bill" }]);
  const files = filesFromPayload(input.files);
  const id = await db.$transaction(async (tx) => {
    const clinic = await requireClinic(tx, tenantId, input.clinicId, actor.id);
    const supplier = await resolveSupplier(tx, tenantId, input, input.category, actor);
    const drawer = input.paid?.fromDrawer ? await drawerFor(tx, tenantId, actor.id, billedOn, now) : null;
    const expense = await tx.expense.create({
      data: {
        tenantId,
        clinicId: drawer?.clinicId ?? clinic.id,
        supplierId: supplier?.id ?? null,
        category: input.category,
        description: input.description,
        reference: input.reference ?? null,
        billedOn: asDate(billedOn),
        dueOn: dueOn ? asDate(dueOn) : null,
        amount: input.amount,
        note: input.note ?? null,
        createdById: actor.id ?? null,
        createdAt: now,
      },
    });
    if (input.paid) {
      await tx.expensePayment.create({
        data: {
          tenantId,
          expenseId: expense.id,
          clinicId: drawer?.clinicId ?? expense.clinicId,
          amount: input.amount,
          method: input.paid.method,
          paidAt: momentOf(billedOn, timezone, now),
          reference: input.paid.reference ?? null,
          shiftId: drawer?.shiftId ?? null,
          createdById: actor.id ?? null,
          createdAt: now,
        },
      });
    }
    await storeFiles(tx, tenantId, expense.id, files, actor, now);
    return expense.id;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "expense.create",
    entity: "Expense",
    entityId: id,
    after: { category: input.category, amount: input.amount, billedOn, dueOn: dueOn ?? null, paid: input.paid ? { method: input.paid.method, fromDrawer: input.paid.fromDrawer } : null, files: files.length },
  });
  return getExpense(tenantId, id, { role: actor.role, now });
}

export async function getExpense(tenantId: string, id: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<ExpenseDTO> {
  const { today } = await todayOf(tenantId, opts.now ?? new Date());
  const row = await loadExpense(db, tenantId, id, opts.role);
  return (await toDTOs([row], today))[0]!;
}

/** Correct an expense: what it is, its supplier, its amount (never below what is paid), its days, its reference. */
export async function updateExpense(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const input = ExpenseEdit.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await todayOf(tenantId, now);
  const billedOn = realDay(input.billedOn, timezone, "billedOn", today);
  const dueOn = input.dueOn ? realDay(input.dueOn, timezone, "dueOn", today, { future: true }) : null;
  const before = await db.$transaction(async (tx) => {
    const row = await loadExpense(tx, tenantId, id, actor.role);
    if (row.voidedAt) throw new FinanceError(409, "invalid_state", "a voided expense is not changed", { message: "This expense is voided: it no longer changes." });
    assertMayRecord(input.category, actor);
    const paid = row.payments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0);
    if (input.amount < paid) throw new z.ZodError([{ code: "custom", path: ["amount"], message: `Not less than what is paid towards it (${paid.toLocaleString("en-US")} EGP)` }]);
    const supplier = await resolveSupplier(tx, tenantId, input, input.category, actor);
    await tx.expense.update({
      where: { id },
      data: {
        supplierId: supplier?.id ?? null,
        category: input.category,
        description: input.description,
        amount: input.amount,
        billedOn: asDate(billedOn),
        dueOn: dueOn ? asDate(dueOn) : null,
        reference: input.reference ?? null,
        note: input.note ?? null,
        updatedById: actor.id ?? null,
      },
    });
    return row;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "expense.update",
    entity: "Expense",
    entityId: id,
    before: { category: before.category, amount: before.amount, billedOn: keyOf(before.billedOn), dueOn: before.dueOn ? keyOf(before.dueOn) : null, supplierId: before.supplierId },
    after: { category: input.category, amount: input.amount, billedOn, dueOn, description: input.description },
  });
  return getExpense(tenantId, id, { role: actor.role, now });
}

/** The owner voids an expense entered by mistake, with the reason; its payments are voided with it (a drawer's cash only while its day is open). */
export async function voidExpense(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const input = ExpenseVoidInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const row = await db.$transaction(async (tx) => {
    const e = await loadExpense(tx, tenantId, id, actor.role);
    if (e.voidedAt) throw new FinanceError(409, "invalid_state", "the expense is voided already", { message: "This expense is voided already." });
    const live = e.payments.filter((p) => !p.voidedAt);
    for (const p of live) if (p.shiftId) await assertDayOpen(tx, tenantId, p.clinicId, p.paidAt, "the cash paid out of the drawer stays; the expense is not voided.");
    if (live.length) await tx.expensePayment.updateMany({ where: { id: { in: live.map((p) => p.id) } }, data: { voidedAt: now, voidedById: actor.id ?? null, voidReason: `The expense was voided: ${input.reason}` } });
    await tx.expense.update({ where: { id }, data: { voidedAt: now, voidedById: actor.id ?? null, voidReason: input.reason } });
    return { ...e, voided: live.length };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.void", entity: "Expense", entityId: id, after: { amount: row.amount, category: row.category, reason: input.reason, paymentsVoided: row.voided } });
  return getExpense(tenantId, id, { role: actor.role, now });
}

/** Pay towards an expense: never past what is owed; cash at the desk today out of the cashier's drawer. */
export async function payExpense(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const input = ExpensePaymentInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const { timezone, today } = await todayOf(tenantId, now);
  const paidOn = input.paidOn ? realDay(input.paidOn, timezone, "paidOn", today) : today;
  const paymentId = await db.$transaction(async (tx) => {
    const e = await loadExpense(tx, tenantId, id, actor.role);
    if (e.voidedAt) throw new FinanceError(409, "invalid_state", "a voided expense takes no payment", { message: "This expense is voided: nothing is paid towards it." });
    const owed = e.amount - e.payments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0);
    if (owed <= 0) throw new FinanceError(409, "paid_in_full", "the expense is paid in full", { message: "This expense is paid in full already." });
    if (input.amount > owed) throw new z.ZodError([{ code: "custom", path: ["amount"], message: `At most what is owed (${owed.toLocaleString("en-US")} EGP)` }]);
    if (paidOn < keyOf(e.billedOn)) throw new z.ZodError([{ code: "custom", path: ["paidOn"], message: "Not before the day of the bill" }]);
    const drawer = input.fromDrawer ? await drawerFor(tx, tenantId, actor.id, paidOn, now) : null;
    const p = await tx.expensePayment.create({
      data: {
        tenantId,
        expenseId: e.id,
        clinicId: drawer?.clinicId ?? e.clinicId,
        amount: input.amount,
        method: input.method,
        paidAt: momentOf(paidOn, timezone, now),
        reference: input.reference ?? null,
        shiftId: drawer?.shiftId ?? null,
        note: input.note ?? null,
        createdById: actor.id ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    return p.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.pay", entity: "Expense", entityId: id, after: { paymentId, amount: input.amount, method: input.method, paidOn, fromDrawer: input.fromDrawer } });
  return getExpense(tenantId, id, { role: actor.role, now });
}

/** The owner voids a payment entered by mistake, with the reason (a drawer's cash only while its day is open): what it paid is owed again. */
export async function voidExpensePayment(tenantId: string, paymentId: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const input = ExpenseVoidInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const p = await db.expensePayment.findFirst({ where: { id: paymentId, tenantId, expense: visibleTo(actor.role) } });
  if (!p) throw new ExpenseNotFoundError(paymentId, "expense_payment");
  if (p.voidedAt) throw new FinanceError(409, "invalid_state", "the payment is voided already", { message: "This payment is voided already." });
  await db.$transaction(async (tx) => {
    if (p.shiftId) await assertDayOpen(tx, tenantId, p.clinicId, p.paidAt, "the cash paid out of the drawer stays.");
    await tx.expensePayment.update({ where: { id: p.id }, data: { voidedAt: now, voidedById: actor.id ?? null, voidReason: input.reason } });
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.payment_void", entity: "Expense", entityId: p.expenseId, after: { paymentId: p.id, amount: p.amount, method: p.method, reason: input.reason } });
  return getExpense(tenantId, p.expenseId, { role: actor.role, now });
}

/** Add photos or PDFs of the bill or the receipt. */
export async function addExpenseFiles(tenantId: string, id: string, rawFiles: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<ExpenseDTO> {
  const now = opts.now ?? new Date();
  const files = filesFromPayload(rawFiles);
  if (!files.length) throw new z.ZodError([{ code: "custom", path: ["files"], message: "Choose a photo or a PDF" }]);
  await db.$transaction(async (tx) => {
    const e = await loadExpense(tx, tenantId, id, actor.role);
    if (e.voidedAt) throw new FinanceError(409, "invalid_state", "a voided expense takes no file", { message: "This expense is voided: nothing more is added to it." });
    await storeFiles(tx, tenantId, e.id, files, actor, now);
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.file_add", entity: "Expense", entityId: id, after: { files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, sizeBytes: f.bytes.length })) } });
  return getExpense(tenantId, id, { role: actor.role, now });
}

/** The owner removes a file attached by mistake (a photo of something else). */
export async function removeExpenseFile(tenantId: string, fileId: string, actor: ExpenseActor = {}): Promise<ExpenseDTO> {
  const f = await db.expenseFile.findFirst({ where: { id: fileId, tenantId, expense: visibleTo(actor.role) }, select: { id: true, blobId: true, expenseId: true, name: true, mimeType: true } });
  if (!f) throw new ExpenseNotFoundError(fileId, "expense_file");
  // The file's row goes with its blob.
  await db.fileBlob.delete({ where: { id: f.blobId } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.file_remove", entity: "Expense", entityId: f.expenseId, before: { fileId: f.id, name: f.name, mimeType: f.mimeType } });
  return getExpense(tenantId, f.expenseId, { role: actor.role });
}

/** A file's bytes, for whoever may see its expense; null otherwise. */
export async function expenseFileFor(tenantId: string, fileId: string, role: UserRole | null | undefined): Promise<{ name: string | null; mimeType: string; bytes: Uint8Array } | null> {
  const f = await db.expenseFile.findFirst({ where: { id: fileId, tenantId, expense: visibleTo(role) }, select: { name: true, mimeType: true, blobId: true } });
  if (!f) return null;
  const blob = await db.fileBlob.findFirst({ where: { id: f.blobId, tenantId }, select: { bytes: true } });
  return blob ? { name: f.name, mimeType: f.mimeType, bytes: blob.bytes } : null;
}

/** What the expense dialogs need: the suppliers in use, the branches, the clock, whether salaries may be recorded, and the user's drawer. */
export async function expenseFormContext(tenantId: string, user: { id: string | null; role: UserRole }, now: Date = new Date()) {
  const { timezone, today } = await todayOf(tenantId, now);
  const [suppliers, clinics, shift] = await Promise.all([
    db.supplier.findMany({ where: { tenantId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, category: true } }),
    db.clinic.findMany({ where: { tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
    user.id ? openShiftOf(db, tenantId, user.id) : null,
  ]);
  const drawerOpen = !!shift && dateKeyInTz(shift.openedAt, await branchTimezone(db, tenantId, shift.clinicId)) === dateKeyInTz(now, await branchTimezone(db, tenantId, shift.clinicId));
  return { suppliers, clinics, timezone, today, canSalaries: isOwner(user.role), drawerOpen };
}

// ── Lists and figures ────────────────────────────────────────────────────────

const monthRange = (month: string) => ({ gte: asDate(`${month}-01`), lt: asDate(`${shiftMonth(month, 1)}-01`) });

function searchWhere(q: string | undefined): Prisma.ExpenseWhereInput {
  if (!q) return {};
  return {
    OR: [
      { description: { contains: q, mode: "insensitive" } },
      { reference: { contains: q, mode: "insensitive" } },
      { note: { contains: q, mode: "insensitive" } },
      { supplier: { name: { contains: q, mode: "insensitive" } } },
    ],
  };
}

/** The ids of the expenses still owed on (not voided), the soonest due first, those with no day last. */
async function owedIds(tenantId: string, where: Prisma.ExpenseWhereInput): Promise<string[]> {
  const rows = await db.expense.findMany({
    where: { tenantId, voidedAt: null, ...where },
    select: { id: true, amount: true, dueOn: true, billedOn: true, payments: { where: { voidedAt: null }, select: { amount: true } } },
  });
  return rows
    .filter((r) => r.amount > r.payments.reduce((s, p) => s + p.amount, 0))
    .sort((a, b) => (a.dueOn?.getTime() ?? Infinity) - (b.dueOn?.getTime() ?? Infinity) || a.billedOn.getTime() - b.billedOn.getTime() || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

/** The Expenses page's lists: what is still to pay (soonest due first), a month's expenses, the voided ones. */
export async function listExpenses(tenantId: string, rawQuery: unknown = {}, opts: { role?: UserRole | null; now?: Date } = {}): Promise<ExpenseList> {
  const query = ExpenseListQuery.parse(rawQuery);
  const { timezone, today } = await todayOf(tenantId, opts.now ?? new Date());
  const month = query.month ?? monthOfKey(today);
  const where: Prisma.ExpenseWhereInput = {
    ...visibleTo(opts.role),
    ...(query.category ? { category: query.category } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...searchWhere(query.q),
  };
  const skip = (query.page - 1) * query.pageSize;
  let rows: ExpenseRow[];
  let total: number;
  let amount = 0;
  let byCategory: ExpenseList["byCategory"] = [];
  if (query.view === "due") {
    const ids = await owedIds(tenantId, where);
    total = ids.length;
    const pageIds = ids.slice(skip, skip + query.pageSize);
    const found = await db.expense.findMany({ where: { tenantId, id: { in: pageIds } }, include: expenseInclude });
    const order = new Map(pageIds.map((id, i) => [id, i]));
    rows = found.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  } else {
    const scoped: Prisma.ExpenseWhereInput =
      query.view === "voided"
        ? { tenantId, voidedAt: { not: null }, ...where }
        : { tenantId, voidedAt: null, ...(query.view === "month" ? { billedOn: monthRange(month) } : {}), ...where };
    const [found, count, groups] = await Promise.all([
      db.expense.findMany({ where: scoped, include: expenseInclude, orderBy: query.view === "voided" ? [{ voidedAt: "desc" }] : [{ billedOn: "desc" }, { createdAt: "desc" }], skip, take: query.pageSize }),
      db.expense.count({ where: scoped }),
      query.view === "month" ? db.expense.groupBy({ by: ["category"], where: scoped, _sum: { amount: true } }) : [],
    ]);
    rows = found;
    total = count;
    byCategory = groups
      .map((g) => ({ category: g.category, label: EXPENSE_CATEGORY_LABELS[g.category], amount: g._sum.amount ?? 0 }))
      .filter((g) => g.amount > 0)
      .sort((x, y) => y.amount - x.amount || x.label.localeCompare(y.label));
    amount = byCategory.reduce((sum, g) => sum + g.amount, 0);
  }
  return { view: query.view, month, monthLabel: monthLabel(month), timezone, today, rows: await toDTOs(rows, today), total, page: query.page, pageSize: query.pageSize, amount, byCategory };
}

/** The figures at the top of the Expenses page (salaries only in the owner's). */
export async function expenseKpis(tenantId: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<ExpenseKpis> {
  const now = opts.now ?? new Date();
  const { timezone, today } = await todayOf(tenantId, now);
  const month = monthOfKey(today);
  const visible = visibleTo(opts.role);
  const range = monthRange(month);
  const monthStart = fromDateKey(`${month}-01`, timezone)!;
  const [open, thisMonth, paid] = await Promise.all([
    db.expense.findMany({ where: { tenantId, voidedAt: null, ...visible }, select: { amount: true, dueOn: true, payments: { where: { voidedAt: null }, select: { amount: true } } } }),
    db.expense.groupBy({ by: ["category"], where: { tenantId, voidedAt: null, billedOn: range, ...visible }, _sum: { amount: true } }),
    db.expensePayment.aggregate({ where: { tenantId, voidedAt: null, paidAt: { gte: monthStart, lte: now }, expense: visible }, _sum: { amount: true } }),
  ]);
  const toPay = { amount: 0, bills: 0 };
  const overdue = { amount: 0, bills: 0 };
  for (const e of open) {
    const owed = e.amount - e.payments.reduce((s, p) => s + p.amount, 0);
    if (owed <= 0) continue;
    toPay.amount += owed;
    toPay.bills += 1;
    if (e.dueOn && keyOf(e.dueOn) < today) {
      overdue.amount += owed;
      overdue.bills += 1;
    }
  }
  const byCategory = thisMonth
    .map((g) => ({ category: g.category, label: EXPENSE_CATEGORY_LABELS[g.category], amount: g._sum.amount ?? 0 }))
    .filter((g) => g.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
  return { timezone, today, month, spentThisMonth: byCategory.reduce((s, g) => s + g.amount, 0), toPay, overdue, paidThisMonth: paid._sum.amount ?? 0, byCategory };
}

// ── Recurring expenses ───────────────────────────────────────────────────────

/** The day of a recurring expense's bill in a month (YYYY-MM-DD). */
const dayIn = (month: string, dayOfMonth: number) => `${month}-${pad(dayOfMonth)}`;

/** The months a recurring expense makes a bill in, from its first, up to and with `untilMonth`. */
export function recurringMonths(r: { startMonth: string; everyMonths: number }, untilMonth: string): string[] {
  const months: string[] = [];
  for (let m = r.startMonth; m <= untilMonth && months.length < 600; m = shiftMonth(m, r.everyMonths)) months.push(m);
  return months;
}

/** Its next bill's day after today (or today, when not made yet). */
function nextBillOn(r: { startMonth: string; everyMonths: number; dayOfMonth: number }, today: string, made: Set<string>): string {
  for (let m = r.startMonth, i = 0; i < 600; m = shiftMonth(m, r.everyMonths), i++) {
    const day = dayIn(m, r.dayOfMonth);
    if (day > today || (day === today && !made.has(m))) return day;
  }
  return dayIn(r.startMonth, r.dayOfMonth);
}

const recurringInclude = {
  clinic: { select: { id: true, name: true } },
  supplier: { select: { id: true, name: true } },
  expenses: { select: { period: true, billedOn: true }, orderBy: { billedOn: "desc" } },
} satisfies Prisma.RecurringExpenseInclude;

function recurringDTO(r: Prisma.RecurringExpenseGetPayload<{ include: typeof recurringInclude }>, today: string): RecurringDTO {
  const made = new Set(r.expenses.map((e) => e.period!).filter(Boolean));
  return {
    id: r.id,
    clinic: r.clinic,
    supplier: r.supplier,
    category: r.category,
    categoryLabel: EXPENSE_CATEGORY_LABELS[r.category],
    description: r.description,
    amount: r.amount,
    everyMonths: r.everyMonths,
    dayOfMonth: r.dayOfMonth,
    dueDays: r.dueDays,
    startMonth: r.startMonth,
    note: r.note,
    stoppedAt: r.stoppedAt?.toISOString() ?? null,
    stopReason: r.stopReason,
    nextOn: r.stoppedAt ? null : nextBillOn(r, today, made),
    made: r.expenses.length,
    lastOn: r.expenses[0] ? keyOf(r.expenses[0].billedOn) : null,
  };
}

/** The recurring expenses: those running first (the next bill soonest), then those stopped. */
export async function listRecurring(tenantId: string, opts: { role?: UserRole | null; now?: Date } = {}): Promise<RecurringDTO[]> {
  const { today } = await todayOf(tenantId, opts.now ?? new Date());
  const rows = await db.recurringExpense.findMany({
    where: { tenantId, ...(isOwner(opts.role) ? {} : { category: { notIn: [...OWNER_ONLY_CATEGORIES] } }) },
    include: recurringInclude,
    orderBy: [{ createdAt: "asc" }],
  });
  return rows
    .map((r) => recurringDTO(r, today))
    .sort((a, b) => Number(!!a.stoppedAt) - Number(!!b.stoppedAt) || (a.nextOn ?? "").localeCompare(b.nextOn ?? "") || a.description.localeCompare(b.description));
}

async function getRecurring(tenantId: string, id: string, now: Date): Promise<RecurringDTO> {
  const { today } = await todayOf(tenantId, now);
  const r = await db.recurringExpense.findFirst({ where: { id, tenantId }, include: recurringInclude });
  if (!r) throw new ExpenseNotFoundError(id, "recurring_expense");
  return recurringDTO(r, today);
}

/** The owner sets up an expense that comes back: its bills from its first month, on their day (those already past are made now). */
export async function createRecurring(tenantId: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<RecurringDTO> {
  const input = RecurringInput.parse(rawInput);
  assertMayRecord(input.category, actor);
  const now = opts.now ?? new Date();
  const { today } = await todayOf(tenantId, now);
  const thisMonth = monthOfKey(today);
  if (input.startMonth < shiftMonth(thisMonth, -12) || input.startMonth > shiftMonth(thisMonth, 12)) {
    throw new z.ZodError([{ code: "custom", path: ["startMonth"], message: "From a year back to a year ahead" }]);
  }
  const id = await db.$transaction(async (tx) => {
    const clinic = await requireClinic(tx, tenantId, input.clinicId, actor.id);
    const supplier = await resolveSupplier(tx, tenantId, input, input.category, actor);
    const r = await tx.recurringExpense.create({
      data: {
        tenantId,
        clinicId: clinic.id,
        supplierId: supplier?.id ?? null,
        category: input.category,
        description: input.description,
        amount: input.amount,
        everyMonths: input.everyMonths,
        dayOfMonth: input.dayOfMonth,
        dueDays: input.dueDays,
        startMonth: input.startMonth,
        note: input.note ?? null,
        createdById: actor.id ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    return r.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.recurring_create", entity: "RecurringExpense", entityId: id, after: { ...input, supplierName: undefined } });
  await makeRecurringBills(tenantId, now, { recurringId: id });
  return getRecurring(tenantId, id, now);
}

/** Change what a recurring expense makes from now on: its amount, what it is, its supplier, its days to pay. Bills made stay as they are. */
export async function updateRecurring(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<RecurringDTO> {
  const input = RecurringEdit.parse(rawInput);
  assertMayRecord(input.category, actor);
  const now = opts.now ?? new Date();
  const before = await db.$transaction(async (tx) => {
    const r = await tx.recurringExpense.findFirst({ where: { id, tenantId } });
    if (!r) throw new ExpenseNotFoundError(id, "recurring_expense");
    if (r.stoppedAt) throw new FinanceError(409, "invalid_state", "a stopped recurring expense is not changed", { message: "This recurring expense is stopped: it no longer changes." });
    assertMayRecord(r.category, actor);
    const supplier = await resolveSupplier(tx, tenantId, input, input.category, actor);
    await tx.recurringExpense.update({
      where: { id },
      data: { supplierId: supplier?.id ?? null, category: input.category, description: input.description, amount: input.amount, dueDays: input.dueDays, note: input.note ?? null, updatedById: actor.id ?? null },
    });
    return r;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "expense.recurring_update",
    entity: "RecurringExpense",
    entityId: id,
    before: { amount: before.amount, description: before.description, category: before.category, dueDays: before.dueDays },
    after: { amount: input.amount, description: input.description, category: input.category, dueDays: input.dueDays },
  });
  return getRecurring(tenantId, id, now);
}

/** The owner stops a recurring expense, with the reason: no more bills from it (those made stay to be paid). */
export async function stopRecurring(tenantId: string, id: string, rawInput: unknown, actor: ExpenseActor = {}, opts: { now?: Date } = {}): Promise<RecurringDTO> {
  const input = RecurringStopInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const r = await db.recurringExpense.findFirst({ where: { id, tenantId } });
  if (!r) throw new ExpenseNotFoundError(id, "recurring_expense");
  assertMayRecord(r.category, actor);
  if (r.stoppedAt) throw new FinanceError(409, "invalid_state", "the recurring expense is stopped already", { message: "This recurring expense is stopped already." });
  await db.recurringExpense.update({ where: { id }, data: { stoppedAt: now, stoppedById: actor.id ?? null, stopReason: input.reason } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.recurring_stop", entity: "RecurringExpense", entityId: id, after: { reason: input.reason } });
  return getRecurring(tenantId, id, now);
}

export interface RecurringRunSummary {
  tenants: number;
  made: number;
}

/**
 * Make the bills of the recurring expenses whose day has come: one for each of
 * their months up to today, at the amount they have now, to be paid by their
 * day plus the days they give. Run by the job `recurring-expenses`; a month
 * made already is never made again (the database holds one per month).
 */
export async function makeRecurringBills(tenantId: string | null, now: Date = new Date(), opts: { recurringId?: string } = {}): Promise<RecurringRunSummary> {
  const summary: RecurringRunSummary = { tenants: 0, made: 0 };
  const tenants = tenantId ? [{ id: tenantId }] : await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true } });
  for (const tenant of tenants) {
    summary.tenants += 1;
    const { today } = await todayOf(tenant.id, now);
    const thisMonth = monthOfKey(today);
    const running = await db.recurringExpense.findMany({
      where: { tenantId: tenant.id, stoppedAt: null, startMonth: { lte: thisMonth }, ...(opts.recurringId ? { id: opts.recurringId } : {}) },
      include: { expenses: { select: { period: true } } },
    });
    for (const r of running) {
      const made = new Set(r.expenses.map((e) => e.period));
      for (const month of recurringMonths(r, thisMonth)) {
        const day = dayIn(month, r.dayOfMonth);
        if (day > today || made.has(month)) continue;
        try {
          await db.expense.create({
            data: {
              tenantId: tenant.id,
              clinicId: r.clinicId,
              supplierId: r.supplierId,
              category: r.category,
              description: r.description,
              billedOn: asDate(day),
              dueOn: asDate(addDaysKey(day, r.dueDays)),
              amount: r.amount,
              recurringId: r.id,
              period: month,
              createdAt: now,
            },
          });
          summary.made += 1;
        } catch (err) {
          // Made meanwhile by another run.
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
        }
      }
    }
  }
  return summary;
}

export { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseView };
