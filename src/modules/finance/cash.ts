import { Prisma, type PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { addDays, dateKeyInTz, fromDateKey, isValidTimeZone } from "@/lib/time";
import { zDateTime, zOptionalText } from "@/lib/validation";
import { DEFAULT_TIMEZONE } from "@/modules/appointments/service";
import { MAX_AMOUNT, METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "./constants";
import { defaultClinicId } from "./documents";
import { FinanceError } from "./errors";

/**
 * The cash drawer. A cashier opens a shift at their branch's desk with the
 * cash in the drawer (the float); the money they take or pay out that day
 * goes into it. At the close they count what is there, method by method,
 * against what is expected (cash: the float plus what came in less what went
 * out: refunds, and cash paid out of the drawer for an expense), and give the
 * reason for any difference. Once every shift of a day is
 * closed, the owner signs the day off; a day signed off is locked: no money
 * is recorded on it, and none on it is voided (the database refuses it too).
 *
 * Money dated today is taken only in an open shift. Money recorded for an
 * earlier day (entered late) belongs to no shift: the day shows it apart,
 * and it can no longer be entered once that day is signed off.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id?: string | null; email?: string | null; ip?: string | null };

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zMoney = z.number().int().min(0).max(MAX_AMOUNT);

export const ShiftOpenInput = z.object({ clinicId: zOptionalText(64), openingFloat: zMoney });
export const ShiftCloseInput = z.object({
  counts: z.array(z.object({ method: z.enum(PAYMENT_METHODS), counted: zMoney, reason: zOptionalText(300) })).max(PAYMENT_METHODS.length),
  note: zOptionalText(500),
});
export const DayQuery = z.object({ date: zDateKey.optional(), clinicId: zOptionalText(64) });
export const DaySignOffInput = z.object({ date: zDateKey, clinicId: zOptionalText(64), note: zOptionalText(500) });

/** When money was taken: now or earlier, never later (a few minutes of clock drift allowed). */
export const zPaidAt = zDateTime.refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "Not in the future: money is recorded once it is taken");

/** Money that moves the drawer: in (payments, deposits, consultation fees) or out (refunds). */
const signed = (p: { kind: string; amount: number }) => (p.kind === "REFUND" ? -p.amount : p.amount);

export interface MethodLine {
  method: PaymentMethodValue;
  label: string;
  /** What should be there: for cash, the float and what came in less what went out. */
  expected: number;
  /** Counted at the close (null while the shift is open). */
  counted: number | null;
  difference: number | null;
  reason: string | null;
  /** What was expected when the shift was counted, when it has changed since (a payment voided after the count). */
  expectedAtCount: number | null;
}

export interface ShiftView {
  id: string;
  clinicId: string;
  cashier: { id: string; fullName: string };
  status: "OPEN" | "CLOSED";
  openingFloat: number;
  openedAt: string;
  closedAt: string | null;
  payments: number;
  /** Cash paid out of the drawer for expenses (voided ones left out). */
  paidOut: { count: number; amount: number };
  methods: MethodLine[];
  note: string | null;
}

interface StoredCount {
  method: PaymentMethodValue;
  expected: number;
  counted: number;
  difference: number;
  reason: string | null;
}

/** The branch's clock (its own timezone, or the clinic's default). */
export async function branchTimezone(client: Tx | typeof db, tenantId: string, clinicId: string | null): Promise<string> {
  const clinic = clinicId ? await client.clinic.findFirst({ where: { id: clinicId, tenantId }, select: { timezone: true } }) : null;
  return clinic?.timezone && isValidTimeZone(clinic.timezone) ? clinic.timezone : DEFAULT_TIMEZONE;
}

async function requireBranch(client: Tx | typeof db, tenantId: string, clinicId?: string | null): Promise<string> {
  const id = clinicId ?? (await defaultClinicId(client, tenantId));
  if (!id) throw new FinanceError(409, "no_branch", "the clinic has no branch", { message: "Add a branch (a location) to the clinic first." });
  const clinic = await client.clinic.findFirst({ where: { id, tenantId, deletedAt: null }, select: { id: true } });
  if (!clinic) throw new TenantScopeError("clinic", id);
  return id;
}

/** The day signed off at the branch that `at` falls on, if it is. */
export async function closedDayAt(client: Tx | typeof db, tenantId: string, clinicId: string, at: Date): Promise<string | null> {
  const day = dateKeyInTz(at, await branchTimezone(client, tenantId, clinicId));
  const closed = await client.dayClose.findFirst({ where: { tenantId, clinicId, day }, select: { id: true } });
  return closed ? day : null;
}

/** Which of the days the dates fall on (on the branch's clock) are signed off there. */
export async function closedDaysAmong(client: Tx | typeof db, tenantId: string, clinicId: string, dates: readonly Date[]): Promise<{ dayOf: (d: Date) => string; closed: Set<string> }> {
  const tz = await branchTimezone(client, tenantId, clinicId);
  const dayOf = (d: Date) => dateKeyInTz(d, tz);
  const days = [...new Set(dates.map(dayOf))];
  const rows = days.length ? await client.dayClose.findMany({ where: { tenantId, clinicId, day: { in: days } }, select: { day: true } }) : [];
  return { dayOf, closed: new Set(rows.map((r) => r.day)) };
}

const dayClosedError = (day: string, action: string) =>
  new FinanceError(409, "day_closed", `the day ${day} is signed off`, { day, message: `${day} is signed off at this branch: ${action}` });

/** The actor's open shift, if they have one. */
export function openShiftOf(client: Tx | typeof db, tenantId: string, userId: string) {
  return client.cashShift.findFirst({ where: { tenantId, userId, status: "OPEN" }, select: { id: true, clinicId: true, openedAt: true } });
}

/**
 * Where money recorded now goes. Dated today: into the actor's open shift
 * (required, and opened today), at the shift's branch, where the drawer is.
 * Entered late for an earlier day, or recorded by no one at the desk (an
 * import): into no shift, at its visit's branch, else the cashier's, else the
 * first. Either way, never on a day signed off.
 */
export async function cashFor(tx: Tx, tenantId: string, actorId: string | null | undefined, paidAt: Date, visitBranch: () => Promise<string | null>): Promise<{ shiftId: string | null; clinicId: string | null }> {
  const shift = actorId ? await openShiftOf(tx, tenantId, actorId) : null;
  const visit = await visitBranch();
  const clinicId = shift?.clinicId ?? visit ?? (await defaultClinicId(tx, tenantId));
  const tz = await branchTimezone(tx, tenantId, clinicId);
  const today = dateKeyInTz(new Date(), tz);
  const assertOpen = async (branch: string | null) => {
    const closed = branch ? await closedDayAt(tx, tenantId, branch, paidAt) : null;
    if (closed) throw dayClosedError(closed, "no money is recorded on it.");
  };
  if (!actorId || dateKeyInTz(paidAt, tz) < today) {
    // In no drawer: booked where it was taken.
    const booked = visit ?? clinicId;
    await assertOpen(booked);
    return { shiftId: null, clinicId: booked };
  }
  await assertOpen(clinicId);
  if (!shift) {
    throw new FinanceError(409, "no_shift", "money is taken in an open shift", { message: "Open your shift first (Cash drawer): money taken today goes into it." });
  }
  // A shift is one day's: one left open from an earlier day takes nothing more.
  const opened = dateKeyInTz(shift.openedAt, tz);
  if (opened < today) {
    throw new FinanceError(409, "stale_shift", "the cashier's open shift is from an earlier day", { day: opened, message: `Your shift from ${opened} is still open: close it (Cash drawer), then open today's.` });
  }
  return { shiftId: shift.id, clinicId: shift.clinicId };
}

/** Refuse to change money on a day signed off (voiding a payment). */
export async function assertDayOpen(tx: Tx, tenantId: string, clinicId: string | null, at: Date, action: string): Promise<void> {
  if (!clinicId) return;
  const closed = await closedDayAt(tx, tenantId, clinicId, at);
  if (closed) throw dayClosedError(closed, action);
}

/**
 * What should be in a shift's drawer, per method: the money in less the money out (voided payments left out); cash with
 * the float, less the cash paid out of it for expenses.
 */
async function expectedFor(
  client: Tx | typeof db,
  tenantId: string,
  shift: { id: string; openingFloat: number },
): Promise<{ byMethod: Map<PaymentMethodValue, number>; payments: number; paidOut: { count: number; amount: number } }> {
  const [rows, outs] = await Promise.all([
    client.payment.findMany({ where: { tenantId, shiftId: shift.id, deletedAt: null }, select: { kind: true, method: true, amount: true } }),
    client.expensePayment.findMany({ where: { tenantId, shiftId: shift.id, voidedAt: null }, select: { amount: true } }),
  ]);
  const byMethod = new Map<PaymentMethodValue, number>([["CASH", shift.openingFloat]]);
  for (const r of rows) byMethod.set(r.method, (byMethod.get(r.method) ?? 0) + signed(r));
  const paidOut = { count: outs.length, amount: outs.reduce((sum, o) => sum + o.amount, 0) };
  if (paidOut.amount) byMethod.set("CASH", (byMethod.get("CASH") ?? 0) - paidOut.amount);
  return { byMethod, payments: rows.length, paidOut };
}

const ORDER = new Map(PAYMENT_METHODS.map((m, i) => [m, i]));

function methodLines(expected: Map<PaymentMethodValue, number>, stored: StoredCount[] | null): MethodLine[] {
  const counted = new Map((stored ?? []).map((c) => [c.method, c]));
  const methods = [...new Set([...expected.keys(), ...counted.keys()])].sort((x, y) => (ORDER.get(x) ?? 0) - (ORDER.get(y) ?? 0));
  return methods.map((method) => {
    const now = expected.get(method) ?? 0;
    const count = counted.get(method) ?? null;
    return {
      method,
      label: METHOD_LABELS[method],
      expected: now,
      counted: count ? count.counted : stored ? 0 : null,
      difference: count ? count.counted - now : stored ? -now : null,
      reason: count?.reason ?? null,
      expectedAtCount: count && count.expected !== now ? count.expected : null,
    };
  });
}

const shiftSelect = {
  id: true,
  clinicId: true,
  status: true,
  openingFloat: true,
  openedAt: true,
  closedAt: true,
  counts: true,
  note: true,
  user: { select: { id: true, fullName: true, email: true } },
} as const;

type ShiftRow = Prisma.CashShiftGetPayload<{ select: typeof shiftSelect }>;

async function toView(client: Tx | typeof db, tenantId: string, s: ShiftRow): Promise<ShiftView> {
  const { byMethod, payments, paidOut } = await expectedFor(client, tenantId, s);
  return {
    id: s.id,
    clinicId: s.clinicId,
    cashier: { id: s.user.id, fullName: s.user.fullName ?? s.user.email },
    status: s.status,
    openingFloat: s.openingFloat,
    openedAt: s.openedAt.toISOString(),
    closedAt: s.closedAt?.toISOString() ?? null,
    payments,
    paidOut,
    methods: methodLines(byMethod, Array.isArray(s.counts) ? (s.counts as unknown as StoredCount[]) : null),
    note: s.note,
  };
}

/** The actor's open shift, as the desk sees it (null when none is open). */
export async function myShift(tenantId: string, userId: string): Promise<ShiftView | null> {
  const s = await db.cashShift.findFirst({ where: { tenantId, userId, status: "OPEN" }, select: shiftSelect });
  return s ? toView(db, tenantId, s) : null;
}

/** Open a shift at a branch with the cash in the drawer. */
export async function openShift(tenantId: string, userId: string, rawInput: unknown, actor: Actor = {}): Promise<ShiftView> {
  const input = ShiftOpenInput.parse(rawInput);
  const now = new Date();
  const shift = await db.$transaction(async (tx) => {
    const clinicId = await requireBranch(tx, tenantId, input.clinicId);
    const closed = await closedDayAt(tx, tenantId, clinicId, now);
    if (closed) throw dayClosedError(closed, "no shift opens on it.");
    if (await openShiftOf(tx, tenantId, userId)) {
      throw new FinanceError(409, "shift_open", "the cashier has an open shift", { message: "Your shift is open already: close it before opening another." });
    }
    try {
      return await tx.cashShift.create({ data: { tenantId, clinicId, userId, openingFloat: input.openingFloat, openedAt: now }, select: shiftSelect });
    } catch (err) {
      // Two opens at once: the one-open-shift index keeps one.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new FinanceError(409, "shift_open", "the cashier has an open shift", { message: "Your shift is open already." });
      }
      throw err;
    }
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "cash.shift.open", entity: "CashShift", entityId: shift.id, after: { clinicId: shift.clinicId, openingFloat: shift.openingFloat } });
  return toView(db, tenantId, shift);
}

/**
 * Close a shift with what was counted, method by method: every method that
 * moved is counted (cash always), and any difference needs its reason. The
 * cashier closes their own shift; the owner can close anyone's.
 */
export async function closeShift(tenantId: string, shiftId: string, closer: { userId: string; isOwner: boolean }, rawInput: unknown, actor: Actor = {}): Promise<ShiftView> {
  const input = ShiftCloseInput.parse(rawInput);
  const now = new Date();
  const closed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "cash_shifts" WHERE id = ${shiftId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const shift = await tx.cashShift.findFirst({ where: { id: shiftId, tenantId }, select: shiftSelect });
    if (!shift) throw new FinanceError(404, "not_found", `shift ${shiftId} not found in tenant`, { entity: "shift" });
    if (shift.status !== "OPEN") throw new FinanceError(409, "invalid_state", "the shift is closed", { status: shift.status, action: "closed", message: "This shift is closed already." });
    if (shift.user.id !== closer.userId && !closer.isOwner) {
      throw new FinanceError(403, "not_your_shift", "a cashier closes their own shift", { message: "Only the cashier, or the clinic owner, closes this shift." });
    }
    const { byMethod } = await expectedFor(tx, tenantId, shift);
    const given = new Map(input.counts.map((c) => [c.method, c]));
    const issues: { path: (string | number)[]; message: string }[] = [];
    const counts: StoredCount[] = [];
    const methods = [...new Set([...byMethod.keys(), ...given.keys()])].sort((x, y) => (ORDER.get(x) ?? 0) - (ORDER.get(y) ?? 0));
    for (const method of methods) {
      const expected = byMethod.get(method) ?? 0;
      const count = given.get(method);
      if (!count) {
        if (expected !== 0) issues.push({ path: ["counts", method], message: `Count the ${METHOD_LABELS[method].toLowerCase()}` });
        continue;
      }
      const difference = count.counted - expected;
      if (difference !== 0 && !count.reason) issues.push({ path: ["counts", method, "reason"], message: `Say why the ${METHOD_LABELS[method].toLowerCase()} is ${difference > 0 ? "over" : "short"} by ${Math.abs(difference).toLocaleString("en-US")} EGP` });
      counts.push({ method, expected, counted: count.counted, difference, reason: count.reason ?? null });
    }
    if (issues.length) throw new z.ZodError(issues.map((i) => ({ code: "custom" as const, path: i.path, message: i.message })));
    return tx.cashShift.update({
      where: { id: shiftId },
      data: { status: "CLOSED", closedAt: now, counts: counts as unknown as Prisma.InputJsonArray, note: input.note ?? null },
      select: shiftSelect,
    });
  });
  const counts = (closed.counts as unknown as StoredCount[]) ?? [];
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "cash.shift.close",
    entity: "CashShift",
    entityId: shiftId,
    after: { cashierId: closed.user.id, counts: counts.map((c) => ({ method: c.method, expected: c.expected, counted: c.counted, difference: c.difference, reason: c.reason })) },
  });
  return toView(db, tenantId, closed);
}

export interface DayTotals {
  method: PaymentMethodValue;
  label: string;
  expected: number;
  /** Null until every shift of the day is closed: a drawer still open is not short. */
  counted: number | null;
  difference: number | null;
}

export interface DayView {
  date: string;
  today: string;
  timezone: string;
  clinic: { id: string; name: string };
  clinics: { id: string; name: string }[];
  shifts: ShiftView[];
  /** Money dated this day that belongs to no shift: entered late, or a card-machine import. */
  outside: { count: number; methods: { method: PaymentMethodValue; label: string; amount: number }[] };
  totals: DayTotals[];
  signedOff: { at: string; by: string | null; note: string | null } | null;
  /** Every shift closed, the day not in the future and not signed off yet. */
  canSignOff: boolean;
  /** Shifts still open from an earlier day at this branch. */
  stale: { id: string; cashier: string; openedAt: string }[];
}

/** A branch's day at the drawer: its shifts, the money outside them, the totals per method, and whether it is signed off. */
export async function getCashDay(tenantId: string, rawQuery: unknown = {}): Promise<DayView> {
  const query = DayQuery.parse(rawQuery);
  const clinicId = await requireBranch(db, tenantId, query.clinicId);
  const tz = await branchTimezone(db, tenantId, clinicId);
  const today = dateKeyInTz(new Date(), tz);
  const date = query.date ?? today;
  const start = fromDateKey(date, tz);
  if (!start) throw new z.ZodError([{ code: "custom", path: ["date"], message: "Not a real date" }]);
  const end = fromDateKey(dateKeyInTz(addDays(start, 1, tz), tz), tz)!;
  const [clinics, rows, outside, close, stale] = await Promise.all([
    db.clinic.findMany({ where: { tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
    db.cashShift.findMany({ where: { tenantId, clinicId, openedAt: { gte: start, lt: end } }, orderBy: { openedAt: "asc" }, select: shiftSelect }),
    db.payment.findMany({ where: { tenantId, clinicId, shiftId: null, deletedAt: null, paidAt: { gte: start, lt: end } }, select: { kind: true, method: true, amount: true } }),
    db.dayClose.findFirst({ where: { tenantId, clinicId, day: date }, select: { closedAt: true, closedById: true, note: true } }),
    db.cashShift.findMany({ where: { tenantId, clinicId, status: "OPEN", openedAt: { lt: fromDateKey(today, tz)! } }, select: { id: true, openedAt: true, user: { select: { fullName: true, email: true } } } }),
  ]);
  const shifts = await Promise.all(rows.map((s) => toView(db, tenantId, s)));
  const outsideBy = new Map<PaymentMethodValue, number>();
  for (const p of outside) outsideBy.set(p.method, (outsideBy.get(p.method) ?? 0) + signed(p));
  const totals = new Map<PaymentMethodValue, { method: PaymentMethodValue; label: string; expected: number; counted: number }>();
  const add = (method: PaymentMethodValue, expected: number, counted: number) => {
    const t = totals.get(method) ?? { method, label: METHOD_LABELS[method], expected: 0, counted: 0 };
    t.expected += expected;
    t.counted += counted;
    totals.set(method, t);
  };
  for (const s of shifts) for (const m of s.methods) add(m.method, m.expected, m.counted ?? 0);
  // Money outside the shifts is not in a drawer: counted as it was recorded.
  for (const [method, amount] of outsideBy) add(method, amount, amount);
  const allCounted = shifts.every((s) => s.status === "CLOSED");
  const closer = close?.closedById ? await db.user.findFirst({ where: { id: close.closedById, tenantId }, select: { fullName: true, email: true } }) : null;
  return {
    date,
    today,
    timezone: tz,
    clinic: clinics.find((c) => c.id === clinicId) ?? { id: clinicId, name: "" },
    clinics,
    shifts,
    outside: { count: outside.length, methods: [...outsideBy].map(([method, amount]) => ({ method, label: METHOD_LABELS[method], amount })) },
    totals: [...totals.values()]
      .sort((x, y) => (ORDER.get(x.method) ?? 0) - (ORDER.get(y.method) ?? 0))
      .map((t) => ({ ...t, counted: allCounted ? t.counted : null, difference: allCounted ? t.counted - t.expected : null })),
    signedOff: close ? { at: close.closedAt.toISOString(), by: closer ? (closer.fullName ?? closer.email) : null, note: close.note } : null,
    canSignOff: !close && date <= today && shifts.every((s) => s.status === "CLOSED"),
    stale: stale.map((s) => ({ id: s.id, cashier: s.user.fullName ?? s.user.email, openedAt: s.openedAt.toISOString() })),
  };
}

/** The owner signs a branch's day off once every shift of it is closed; from then on the day is locked. */
export async function signOffDay(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<DayView> {
  const input = DaySignOffInput.parse(rawInput);
  const day = await getCashDay(tenantId, { date: input.date, clinicId: input.clinicId });
  if (day.signedOff) throw new FinanceError(409, "invalid_state", "the day is signed off", { status: "CLOSED", action: "signed off again", message: `${day.date} is signed off already.` });
  if (day.date > day.today) throw new FinanceError(409, "invalid_state", "a day to come is not signed off", { status: "OPEN", action: "signed off before it is over", message: "A day is signed off once it has been worked." });
  const open = day.shifts.filter((s) => s.status === "OPEN");
  if (open.length) {
    throw new FinanceError(409, "shifts_open", "a shift of the day is open", {
      message: `Close every shift of the day first: ${open.map((s) => s.cashier.fullName).join(", ")} still open.`,
    });
  }
  try {
    await db.dayClose.create({
      data: {
        tenantId,
        clinicId: day.clinic.id,
        day: day.date,
        closedAt: new Date(),
        closedById: actor.id ?? null,
        totals: { methods: day.totals, shifts: day.shifts.length, outside: day.outside.count } as unknown as Prisma.InputJsonObject,
        note: input.note ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new FinanceError(409, "invalid_state", "the day is signed off", { status: "CLOSED", action: "signed off again", message: `${day.date} is signed off already.` });
    }
    throw err;
  }
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "cash.day.sign_off", entity: "Clinic", entityId: day.clinic.id, after: { day: day.date, totals: day.totals } });
  return getCashDay(tenantId, { date: day.date, clinicId: day.clinic.id });
}

export type { PaymentMethod };
