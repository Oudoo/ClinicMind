import type { Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { dateKeyInTz } from "../../src/lib/time";

/**
 * The demo clinic's cash drawer: reception's shift on every day money was
 * taken at the desk (1,000 EGP float, the day's money in it, counted at the
 * close, now and then a few pounds out with the reason), every such day
 * signed off by the owner except yesterday, which waits for the owner, and
 * reception's shift open today so the desk can take money straight away.
 * Runs after every step that writes money: a signed-off day takes no more.
 */

const MIN = 60_000;
const FLOAT = 1_000;

type Method = "CASH" | "CARD" | "BANK_TRANSFER" | "WALLET" | "POS" | "INSTAPAY" | "CHEQUE" | "OTHER";
const ORDER: Method[] = ["CASH", "CARD", "BANK_TRANSFER", "WALLET", "POS", "INSTAPAY", "CHEQUE", "OTHER"];

export async function seedCash(ctx: SeedContext): Promise<void> {
  const { db, tenantId, clinicId } = ctx;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const tz = (await db.clinic.findUniqueOrThrow({ where: { id: clinicId }, select: { timezone: true } })).timezone;
  const now = new Date();
  const today = dateKeyInTz(now, tz);
  const yesterday = dateKeyInTz(new Date(now.getTime() - 24 * 60 * MIN), tz);
  const at = (day: string, h: number, m: number) => {
    const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
    return ctx.zoned(y, mo, d, h, m);
  };

  const payments = await db.payment.findMany({
    where: { tenantId, deletedAt: null, importBatchId: null },
    select: { id: true, kind: true, method: true, amount: true, paidAt: true, clinicId: true },
    orderBy: { paidAt: "asc" },
  });
  const days = new Map<string, typeof payments>();
  for (const p of payments) {
    if ((p.clinicId ?? clinicId) !== clinicId) continue;
    const key = dateKeyInTz(p.paidAt, tz);
    days.set(key, [...(days.get(key) ?? []), p]);
  }
  if (!days.has(today)) days.set(today, []);

  let signedOff = 0;
  let differences = 0;
  let index = 0;
  for (const [day, rows] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    index++;
    const isToday = day === today;
    const firstAt = rows[0]?.paidAt.getTime() ?? Number.POSITIVE_INFINITY;
    const lastAt = rows.at(-1)?.paidAt.getTime() ?? 0;
    const openedAt = new Date(Math.min(firstAt, at(day, 9, 45).getTime(), isToday ? now.getTime() - MIN : Number.POSITIVE_INFINITY));
    const closedAt = new Date(Math.max(lastAt + 5 * MIN, at(day, 20, 15).getTime()));
    const expected = new Map<Method, number>([["CASH", FLOAT]]);
    for (const p of rows) expected.set(p.method, (expected.get(p.method) ?? 0) + (p.kind === "REFUND" ? -p.amount : p.amount));
    // Now and then the drawer is a few pounds out, with the reason.
    const slip = index % 23 === 0 ? { amount: -50, reason: "Change given short to a patient" } : index % 37 === 0 ? { amount: 20, reason: "Coins left from the day before" } : null;
    const counts = ORDER.filter((m) => expected.has(m)).map((method) => {
      const exp = expected.get(method)!;
      const off = method === "CASH" && slip ? slip.amount : 0;
      return { method, expected: exp, counted: exp + off, difference: off, reason: off ? slip!.reason : null };
    });
    if (slip && !isToday) differences++;
    const shift = await db.cashShift.create({
      data: {
        tenantId,
        clinicId,
        userId: reception.id,
        status: isToday ? "OPEN" : "CLOSED",
        openingFloat: FLOAT,
        openedAt,
        closedAt: isToday ? null : closedAt,
        counts: isToday ? undefined : (counts as unknown as Prisma.InputJsonArray),
        createdAt: openedAt,
      },
      select: { id: true },
    });
    if (rows.length) await db.payment.updateMany({ where: { id: { in: rows.map((p) => p.id) } }, data: { shiftId: shift.id } });
    // Every day signed off by the owner in the evening, but yesterday (the owner's to do) and today.
    if (!isToday && day !== yesterday) {
      await db.dayClose.create({
        data: {
          tenantId,
          clinicId,
          day,
          closedAt: new Date(closedAt.getTime() + 30 * MIN),
          closedById: owner.id,
          totals: { methods: counts.map((c) => ({ method: c.method, expected: c.expected, counted: c.counted, difference: c.difference })), shifts: 1, outside: 0 },
        },
      });
      signedOff++;
    }
  }
  console.log(`     cash drawer: ${days.size} shifts of ${reception.fullName} (${differences} with a difference and its reason), ${signedOff} days signed off; yesterday waits for the owner; today's shift is open`);
}
