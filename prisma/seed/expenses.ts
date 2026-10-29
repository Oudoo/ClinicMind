import type { SeedContext } from "./index";
import { makeRandom, png } from "./util";
import { dateKeyInTz, fromDateKey } from "../../src/lib/time";
import { monthOfKey } from "../../src/modules/finance/doctor-pay-calc";
import { makeRecurringBills } from "../../src/modules/finance/expenses";

/**
 * The demo clinic's expenses since it started keeping them here, six weeks
 * back (when its booked days start): the suppliers (the landlord, a supplier
 * of materials, the cleaners, the laser engineer, the accountant, a print
 * shop), the recurring bills (rent, salaries for the owner's eyes only,
 * cleaning, the internet, the accountant, a laser service contract) made by
 * the job, and the rest as they came: the supplier's bills on 30 days (one
 * late, one due today, two to come), the electricity, the card machine's fees,
 * a repair, flyers, a charger, and the desk's cash for the waiting room out of
 * the drawer (one today). Past bills are paid on their day; this month's
 * cleaning is late and the laser contract half paid; one bill entered twice is
 * voided. Receipts' photos on the supplier's bills and a few others.
 *
 * Runs before the cash drawer: the desk's cash paid out is handed to it
 * (`ctx.drawerPayouts`), which puts each in its day's shift and counts it.
 */

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const START_DAYS = 42;

/** A receipt-like placeholder: white paper, a dark header, grey lines of print, a total. */
function receiptPhoto(seed: number): Buffer {
  const w = 120;
  const h = 180;
  return png(w, h, (x, y) => {
    const margin = x < 8 || x > w - 9;
    if (y < 18 && !margin) return [60, 72, 84];
    const line = (y - 30) % 11 < 3 && y > 28 && y < h - 30 && !margin && x < w - 20 - ((y * 7 + seed * 13) % 40);
    if (line) return [170, 174, 178];
    if (y > h - 24 && y < h - 16 && x > w / 2 && !margin) return [50, 50, 50];
    return [250, 249, 246];
  });
}

export async function seedExpenses(ctx: SeedContext): Promise<void> {
  const { db, tenantId, clinicId } = ctx;
  const r = makeRandom(5_500);
  const owner = ctx.users.find((u) => u.email === "owner@demo.clinic") ?? ctx.users.find((u) => u.role === "CLINIC_OWNER")!;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? owner;
  const now = ctx.today;
  const todayKey = dateKeyInTz(now, TZ);
  const keyAt = (offset: number) => {
    const d = ctx.calendarDay(offset);
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  };
  const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
  /** An instant on a day key, at an hour (never later than now). */
  const at = (key: string, hour: number) => {
    const t = new Date(fromDateKey(key, TZ)!.getTime() + hour * 3_600_000);
    return t.getTime() > now.getTime() ? new Date(now.getTime() - 60_000) : t;
  };
  const addKey = (key: string, days: number) => new Date(asDate(key).getTime() + days * DAY).toISOString().slice(0, 10);

  // ── Suppliers ──
  const supplierSpecs = [
    { key: "landlord", name: "Hany Saad (landlord)", category: "RENT", contactName: "Hany Saad", phone: "+20 100 412 7781", notes: "Rent by transfer before the 5th; the account number is on the lease." },
    { key: "supplies", name: "Saad & Sons Medical Trading", category: "SUPPLIES", contactName: "Ahmed Saad", phone: "+20 122 908 3317", email: "orders@saadsons.example", notes: "Pays on 30 days. Delivers Sundays and Wednesdays." },
    { key: "cleaning", name: "Sparkle Cleaning Services", category: "CLEANING", phone: "+20 111 655 0042", notes: "Daily evening clean, monthly contract." },
    { key: "laser", name: "Karim Fawzy, laser engineer", category: "MAINTENANCE", phone: "+20 106 233 9184", notes: "Service contract for both laser machines: a visit every three months, calls in between." },
    { key: "accountant", name: "Mona Adel, accountant", category: "FEES", phone: "+20 127 771 2030", email: "mona.adel@accounts.example" },
    { key: "print", name: "Zamalek Print Shop", category: "MARKETING", phone: "+20 2 2735 1188" },
  ] as const;
  const supplier: Record<string, string> = {};
  const startKey = keyAt(-START_DAYS);
  for (const s of supplierSpecs) {
    const row = await db.supplier.create({
      data: { tenantId, name: s.name, category: s.category, contactName: "contactName" in s ? s.contactName : null, phone: s.phone, email: "email" in s ? s.email : null, notes: "notes" in s ? s.notes : null, createdById: owner.id, createdAt: at(startKey, 9) },
      select: { id: true },
    });
    supplier[s.key] = row.id;
  }

  // ── Recurring: from the month the clinic started keeping its expenses here ──
  const startMonth = monthOfKey(startKey);
  const laserFirst = keyAt(-20);
  const recurringSpecs = [
    { key: "rent", supplier: "landlord", category: "RENT", description: "Clinic rent", amount: 45_000, everyMonths: 1, dayOfMonth: 1, dueDays: 5, startMonth, by: owner.id, pay: { method: "BANK_TRANSFER", after: 2, reference: "CIB transfer" } },
    { key: "salaries", supplier: null, category: "SALARIES", description: "Staff salaries: reception, nurse and assistant", amount: 36_000, everyMonths: 1, dayOfMonth: 28, dueDays: 2, startMonth, by: owner.id, pay: { method: "BANK_TRANSFER", after: 0, reference: "Payroll transfer" } },
    { key: "cleaning", supplier: "cleaning", category: "CLEANING", description: "Cleaning contract", amount: 4_500, everyMonths: 1, dayOfMonth: 1, dueDays: 7, startMonth, by: owner.id, pay: { method: "INSTAPAY", after: 5, reference: null }, leaveThisMonth: true },
    { key: "internet", supplier: null, category: "UTILITIES", description: "Internet line and landline", amount: 1_200, everyMonths: 1, dayOfMonth: 15, dueDays: 10, startMonth, by: owner.id, pay: { method: "CARD", after: 4, reference: null } },
    { key: "accountant", supplier: "accountant", category: "FEES", description: "Bookkeeping and tax filing", amount: 3_500, everyMonths: 1, dayOfMonth: 25, dueDays: 5, startMonth, by: owner.id, pay: { method: "BANK_TRANSFER", after: 3, reference: "CIB transfer" }, leaveThisMonth: true },
    {
      key: "laser",
      supplier: "laser",
      category: "MAINTENANCE",
      description: "Laser machines' service contract",
      amount: 12_000,
      everyMonths: 3,
      dayOfMonth: Math.min(28, Number(laserFirst.slice(8))),
      dueDays: 15,
      startMonth: monthOfKey(laserFirst),
      by: owner.id,
      pay: { method: "BANK_TRANSFER", after: 10, reference: "CIB transfer", part: 6_000 },
    },
  ] as const;
  const recurringIds: Record<string, string> = {};
  for (const spec of recurringSpecs) {
    const row = await db.recurringExpense.create({
      data: {
        tenantId,
        clinicId,
        supplierId: spec.supplier ? supplier[spec.supplier]! : null,
        category: spec.category,
        description: spec.description,
        amount: spec.amount,
        everyMonths: spec.everyMonths,
        dayOfMonth: spec.dayOfMonth,
        dueDays: spec.dueDays,
        startMonth: spec.startMonth,
        createdById: spec.by,
        createdAt: at(startKey, 10),
      },
      select: { id: true },
    });
    recurringIds[spec.key] = row.id;
  }
  // What the job made, morning by morning, up to today.
  let made = 0;
  for (let offset = -START_DAYS; offset <= 0; offset++) made += (await makeRecurringBills(tenantId, at(keyAt(offset), 6))).made;
  const thisMonth = monthOfKey(todayKey);
  for (const spec of recurringSpecs) {
    const bills = await db.expense.findMany({ where: { tenantId, recurringId: recurringIds[spec.key]! }, select: { id: true, amount: true, billedOn: true, dueOn: true, period: true } });
    for (const b of bills) {
      if ("leaveThisMonth" in spec && spec.leaveThisMonth && b.period === thisMonth) continue;
      const paidKey = addKey(b.billedOn.toISOString().slice(0, 10), spec.pay.after);
      if (paidKey > todayKey) continue;
      const amount = "part" in spec.pay ? spec.pay.part : b.amount;
      await db.expensePayment.create({
        data: {
          tenantId,
          expenseId: b.id,
          clinicId,
          amount,
          method: spec.pay.method,
          paidAt: at(paidKey, 11),
          reference: spec.pay.reference ? `${spec.pay.reference} ${r.between(1_000, 9_999)}` : null,
          createdById: owner.id,
          createdAt: at(paidKey, 11),
        },
      });
    }
  }

  // ── As they came ──
  type Payment = { method: "CASH" | "CARD" | "BANK_TRANSFER" | "INSTAPAY" | "OTHER"; offset: number; amount?: number; drawer?: boolean; by?: string; reference?: string };
  interface OneOff {
    offset: number;
    supplier?: string;
    category: "SUPPLIES" | "UTILITIES" | "BANK" | "MAINTENANCE" | "MARKETING" | "EQUIPMENT" | "HOSPITALITY" | "TRANSPORT" | "OTHER";
    description: string;
    amount: number;
    dueIn?: number;
    reference?: string;
    by?: string;
    paid?: Payment[];
    photo?: boolean;
    voided?: string;
  }
  const oneOffs: OneOff[] = [];
  // The supplier's bills: one paid in time, one two weeks late, one due today, two to come.
  const supplies: { offset: number; dueIn: number; amount: number; description: string; paidAfter?: number }[] = [
    { offset: -41, dueIn: 30, amount: 14_500, description: "Gloves, gauze, syringes and sutures", paidAfter: 27 },
    { offset: -30, dueIn: 16, amount: 8_200, description: "PRP kits and blood tubes" },
    { offset: -30, dueIn: 30, amount: 11_750, description: "Ultrasound and laser gel, alcohol, cannulas" },
    { offset: -16, dueIn: 30, amount: 6_300, description: "Disposable sheets, masks and gowns" },
    { offset: -4, dueIn: 30, amount: 9_900, description: "Cannulas, numbing cream and sterile dressings" },
  ];
  supplies.forEach((b, i) =>
    oneOffs.push({
      offset: b.offset,
      supplier: "supplies",
      category: "SUPPLIES",
      description: b.description,
      amount: b.amount,
      dueIn: b.dueIn,
      reference: `SST-26${311 + i * 17}`,
      by: reception.id,
      photo: true,
      paid: b.paidAfter !== undefined ? [{ method: "BANK_TRANSFER", offset: b.offset + b.paidAfter, by: owner.id, reference: `CIB transfer ${r.between(1_000, 9_999)}` }] : undefined,
    }),
  );
  // The electricity, read on the 12th, paid on time; the card machine's fees, taken on the 2nd.
  for (let offset = -START_DAYS; offset <= 0; offset++) {
    const day = ctx.calendarDay(offset);
    const key = keyAt(offset);
    if (day.d === 12) oneOffs.push({ offset, category: "UTILITIES", description: `Electricity, ${new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(asDate(key))}`, amount: 4_000 + r.between(4, 16) * 100, dueIn: 10, by: owner.id, paid: offset + 6 <= 0 ? [{ method: "INSTAPAY", offset: offset + 6, by: owner.id }] : undefined });
    if (day.d === 2) oneOffs.push({ offset, category: "BANK", description: "Card machine fees", amount: 1_850 + r.between(0, 6) * 50, by: owner.id, paid: [{ method: "OTHER", offset, by: owner.id, reference: "Taken by the bank" }] });
  }
  oneOffs.push(
    { offset: -35, supplier: "print", category: "MARKETING", description: "Flyers and a roll-up banner for the laser offer", amount: 3_800, by: owner.id, photo: true, paid: [{ method: "CARD", offset: -35, by: owner.id }] },
    { offset: -22, category: "MAINTENANCE", description: "Air-conditioning service, both rooms", amount: 1_400, by: owner.id, paid: [{ method: "CASH", offset: -22, by: owner.id }] },
    { offset: -9, category: "EQUIPMENT", description: "Dermatoscope charger and battery", amount: 2_900, by: owner.id, photo: true, paid: [{ method: "CARD", offset: -9, by: owner.id }] },
    { offset: -6, category: "OTHER", description: "Coffee and tea for the waiting room", amount: 320, by: reception.id, voided: "Entered twice: the same purchase as the line before" },
  );
  // The desk's cash for the waiting room and the courier, out of the drawer, on working days (not Fridays), and today.
  const desk: [string, number, OneOff["category"]][] = [
    ["Water bottles for the waiting room", 180, "HOSPITALITY"],
    ["Coffee and tea for the waiting room", 320, "HOSPITALITY"],
    ["Tissues and paper cups", 140, "HOSPITALITY"],
    ["Courier: biopsy samples to the lab", 150, "TRANSPORT"],
    ["Sugar and milk", 95, "HOSPITALITY"],
  ];
  let k = 0;
  for (let offset = -START_DAYS + 2; offset <= 0; offset += 4) {
    const day = ctx.calendarDay(offset);
    const o = day.weekday === 5 ? offset - 1 : offset;
    const [description, amount, category] = desk[k++ % desk.length]!;
    oneOffs.push({ offset: o, category, description, amount: amount + r.between(0, 4) * 5, by: reception.id, photo: k % 3 === 0, paid: [{ method: "CASH", offset: o, drawer: true, by: reception.id }] });
  }
  oneOffs.push({ offset: 0, category: "HOSPITALITY", description: "Water and coffee for the waiting room", amount: 240, by: reception.id, paid: [{ method: "CASH", offset: 0, drawer: true, by: reception.id }] });
  // The bill entered twice is the same purchase as the desk's last coffee before it.
  const twice = oneOffs.find((x) => x.voided)!;
  const before = oneOffs.filter((x) => x.description === "Coffee and tea for the waiting room" && !x.voided && x.offset <= twice.offset).sort((a, b) => b.offset - a.offset)[0];
  if (before) {
    twice.offset = before.offset;
    twice.amount = before.amount;
  }

  ctx.drawerPayouts ??= [];
  let photos = 0;
  let count = 0;
  for (const e of oneOffs.sort((a, b) => a.offset - b.offset)) {
    const key = keyAt(e.offset);
    const created = at(key, e.paid?.[0]?.drawer ? 12 + (count % 5) : 10);
    const row = await db.expense.create({
      data: {
        tenantId,
        clinicId,
        supplierId: e.supplier ? supplier[e.supplier]! : null,
        category: e.category,
        description: e.description,
        reference: e.reference ?? null,
        billedOn: asDate(key),
        dueOn: e.dueIn !== undefined ? asDate(addKey(key, e.dueIn)) : null,
        amount: e.amount,
        createdById: e.by ?? owner.id,
        createdAt: created,
        ...(e.voided ? { voidedAt: new Date(created.getTime() + 25 * 60_000), voidedById: owner.id, voidReason: e.voided } : {}),
      },
      select: { id: true },
    });
    count += 1;
    for (const p of e.paid ?? []) {
      const payKey = keyAt(p.offset);
      if (payKey > todayKey) continue;
      const payment = { expenseId: row.id, amount: p.amount ?? e.amount, paidAt: p.offset === e.offset ? created : at(payKey, 11), createdById: p.by ?? owner.id };
      if (p.drawer) {
        ctx.drawerPayouts.push(payment);
        continue;
      }
      await db.expensePayment.create({ data: { tenantId, clinicId, method: p.method, reference: p.reference ?? null, ...payment, createdAt: payment.paidAt } });
    }
    if (e.photo) {
      const bytes = receiptPhoto(count);
      const blob = await db.fileBlob.create({ data: { tenantId, mimeType: "image/png", sizeBytes: bytes.length, bytes, createdAt: created }, select: { id: true } });
      await db.expenseFile.create({ data: { tenantId, expenseId: row.id, blobId: blob.id, name: `receipt-${key}.png`, mimeType: "image/png", sizeBytes: bytes.length, createdById: e.by ?? owner.id, createdAt: created } });
      photos += 1;
    }
  }
  console.log(`     ${supplierSpecs.length} suppliers, ${recurringSpecs.length} recurring expenses (${made} bills made), ${count} other expenses (${ctx.drawerPayouts.length} paid out of the drawer), ${photos} receipts`);
}
