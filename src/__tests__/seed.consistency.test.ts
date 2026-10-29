/**
 * Plausible demo data: the core seed's clinical assignment (prisma/seed/clinical.ts,
 * the same helpers prisma/seed.ts calls) gives conditions and comorbidities
 * that respect the patient's sex and allergies that never conflict with the
 * condition's medications.
 *
 * The second half checks a seeded demo database when DATABASE_URL points at one
 * (the "demo" tenant exists) and skips otherwise; the test database has none.
 * To run it against the local demo after `npm run db:seed`:
 *   TEST_DATABASE_URL= npx vitest run src/__tests__/seed.consistency.test.ts
 */
import type { Gender } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import {
  ALLERGY_OPTIONS,
  allergiesFromDraw,
  allergyClass,
  allergyOptionsFor,
  COMORBIDITY_OPTIONS,
  comorbiditiesFor,
  comorbiditiesFromDraw,
  CONDITIONS,
  conditionFor,
  conditionFromDraw,
  conditionsFor,
  conflictingMedications,
  drugClasses,
  medicationStartDays,
} from "../../prisma/seed/clinical";
import { accountPosition } from "@/modules/finance/ledger";
import { END_AFTER_SILENT_DAYS, END_AFTER_WINDOW_DAYS } from "@/modules/recalls/constants";
import { addDays, dateKeyInTz } from "@/lib/time";
import { adjustmentsReport, balancesReport, branchReport, dayCloseReport, incomeReport, productionReport, providersReport, reportScope } from "@/modules/finance/reports";
import { checkPrescribing } from "@/modules/consultations/safety/engine";
import { answerablePassages } from "@/modules/evidence/answer";
import { pregnancyKnown } from "@/modules/patients/pregnancy";
import { cleanSignature, quoteState } from "@/modules/quotes/constants";
import { coverInstalments, planPosition } from "@/modules/finance/instalment-schedule";
import { netPaid } from "@/modules/finance/constants";
import { DEFAULT_REMINDER_SETTINGS, isQuiet } from "@/modules/messaging/reminder-settings";
import { statementFor } from "@/modules/finance/doctor-pay";
import { monthOfKey, settle, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { recurringMonths } from "@/modules/finance/expenses";

const FEMALE_ONLY = /\b(PCOS|polycystic|hirsutism|melasma)\b/i;

/** The seed's PRNG (mulberry32), counting the random numbers drawn. */
function stream(seed: number) {
  let draws = 0;
  const rand = () => {
    draws++;
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rand, draws: () => draws };
}

/** What the old seed's `pick(xs)` returned for the random number `u`. */
const oldPick = <T,>(xs: readonly T[], u: number): T => xs[Math.floor(u * xs.length)]!;

describe("allergy and medication conflicts", () => {
  it("classifies the allergies and the drugs the seed and the clinic use", () => {
    expect(allergyClass("Penicillin")).toBe("penicillin");
    expect(allergyClass("Amoxicillin")).toBe("penicillin");
    expect(allergyClass("Sulfa drugs")).toBe("sulfa");
    expect(allergyClass("NSAIDs")).toBe("nsaid");
    expect(allergyClass("Ibuprofen")).toBe("nsaid");
    expect(allergyClass("Latex")).toBeNull();
    expect(drugClasses("Cephalexin")).toEqual(["cephalosporin"]);
    expect(drugClasses("Cefuroxime 500 mg")).toEqual(["cephalosporin"]);
    expect(drugClasses("Amoxicillin/clavulanate")).toEqual(["penicillin"]);
    expect(drugClasses("Co-trimoxazole")).toEqual(["sulfonamide"]);
    expect(drugClasses("Ibuprofen 400 mg")).toEqual(["nsaid"]);
    expect(drugClasses("Salicylic acid 40% plaster")).toEqual(["salicylate"]);
    expect(drugClasses("Doxycycline")).toEqual([]);
  });

  it("a penicillin allergy rules out cephalosporins, sulfa the sulfonamides, NSAIDs the NSAIDs and salicylates", () => {
    expect(conflictingMedications(["Penicillin"], ["Cephalexin", "Saline spray"])).toEqual(["Cephalexin"]);
    expect(conflictingMedications(["Penicillin"], ["Doxycycline"])).toEqual([]);
    expect(conflictingMedications(["Sulfa drugs"], ["Co-trimoxazole", "Adapalene 0.1% gel"])).toEqual(["Co-trimoxazole"]);
    expect(conflictingMedications(["NSAIDs"], ["Diclofenac gel", "Salicylic acid 40% plaster", "Emollient cream"])).toEqual([
      "Diclofenac gel",
      "Salicylic acid 40% plaster",
    ]);
    expect(conflictingMedications(["Latex"], ["Cephalexin"])).toEqual([]);
  });

  it("a hair-transplant patient (cephalexin) is never penicillin-allergic; a wart patient (salicylic acid) never NSAID-allergic", () => {
    const fue = CONDITIONS.find((c) => c.key === "fue")!;
    expect(allergyOptionsFor(fue)).not.toContainEqual(["Penicillin"]);
    expect(allergyOptionsFor(fue)).toContainEqual(["Sulfa drugs"]);
    const warts = CONDITIONS.find((c) => c.key === "warts")!;
    expect(allergyOptionsFor(warts)).not.toContainEqual(["NSAIDs"]);
    // Everyone else can still carry any of them.
    expect(allergyOptionsFor(CONDITIONS.find((c) => c.key === "eczema")!)).toEqual(ALLERGY_OPTIONS);
  });
});

describe("sex-aware conditions and comorbidities", () => {
  it("PCOS, hirsutism for laser and melasma are for women only; hair loss and transplants for either", () => {
    const male = conditionsFor("MALE").map((c) => c.key);
    const female = conditionsFor("FEMALE").map((c) => c.key);
    expect(male).not.toContain("laser-hr");
    expect(male).not.toContain("melasma");
    expect(male).toEqual(expect.arrayContaining(["aga", "fue", "acne"]));
    expect(female).toEqual(expect.arrayContaining(["aga", "fue", "laser-hr", "melasma"]));
    expect(comorbiditiesFor("MALE")).not.toContainEqual(["PCOS"]);
    expect(comorbiditiesFor("FEMALE")).toContainEqual(["PCOS"]);
  });

  it("words hair loss and acne for the patient's sex", () => {
    const aga = CONDITIONS.find((c) => c.key === "aga")!;
    const her = conditionFor(aga, "FEMALE");
    expect(her.diagnosis).toBe("Female pattern hair loss (Ludwig I)");
    expect(her.meds.map((m) => m.name)).not.toContain("Finasteride");
    expect(conditionFor(aga, "MALE").meds.map((m) => m.name)).toContain("Finasteride");
    const acne = CONDITIONS.find((c) => c.key === "acne")!;
    expect(conditionFor(acne, "MALE").symptoms.join(" ")).not.toMatch(/menstruat/i);
    expect(conditionFor(acne, "FEMALE").symptoms.join(" ")).toMatch(/menstruat/i);
  });

  it("assigns 3,000 patients the way the seed does: plausible every time, the old assignment kept whenever it was plausible", () => {
    const s = stream(20261022);
    const seen = new Set<string>();
    let kept = 0;
    for (let i = 0; i < 3000; i++) {
      const sex: Gender = s.rand() < 0.52 ? "FEMALE" : "MALE";
      const [u1, u2, u3] = [s.rand(), s.rand(), s.rand()];
      const cond = conditionFromDraw(sex, u1);
      const allergies = allergiesFromDraw(cond, u2);
      const comorbid = comorbiditiesFromDraw(sex, u3);

      // The demo changes only where it was implausible: an old pick that fits is kept,
      // and a replacement is seen by the same kind of doctor (the appointment book is unchanged).
      const old = oldPick(CONDITIONS, u1);
      if (conditionsFor(sex).includes(old)) {
        expect(cond.key).toBe(old.key);
        kept++;
      }
      expect(cond.doctor).toBe(old.doctor);
      const oldAllergies = oldPick(ALLERGY_OPTIONS, u2);
      if (!conflictingMedications(oldAllergies, cond.meds.map((m) => m.name)).length) expect(allergies).toEqual(oldAllergies);
      const oldComorbid = oldPick(COMORBIDITY_OPTIONS, u3);
      if (sex === "FEMALE") expect(comorbid).toEqual(oldComorbid);
      // As many medication start dates are drawn as the old seed drew.
      let dateDraws = 0;
      const days = medicationStartDays(cond, u1, () => (dateDraws++, 30 + dateDraws));
      expect(dateDraws).toBe(old.meds.length);
      expect(days).toHaveLength(cond.meds.length);

      const meds = cond.meds.map((m) => m.name);
      expect(conflictingMedications(allergies, meds), `${cond.key} with ${allergies.join(", ")}`).toEqual([]);
      if (allergies.includes("Penicillin")) expect(meds.some((m) => /^ceph|^cef/i.test(m))).toBe(false);
      if (sex === "MALE") {
        expect([cond.diagnosis, ...cond.chronic, ...comorbid].join(" ")).not.toMatch(FEMALE_ONLY);
        expect(cond.symptoms.join(" ")).not.toMatch(/menstruat|pregnan/i);
      } else {
        expect(meds).not.toContain("Finasteride");
      }
      seen.add(`${sex}:${cond.key}`);
      for (const a of allergies) seen.add(`allergy:${a}`);
      for (const c of comorbid) seen.add(`${sex}:${c}`);
    }
    // Still varied: both sexes get hair loss and transplants, women get PCOS and laser, penicillin allergy still occurs.
    for (const key of ["MALE:aga", "FEMALE:aga", "MALE:fue", "FEMALE:fue", "FEMALE:laser-hr", "FEMALE:melasma", "FEMALE:PCOS", "allergy:Penicillin", "allergy:NSAIDs"]) {
      expect(seen.has(key), key).toBe(true);
    }
    expect(kept).toBeGreaterThan(2400);
  });
});

describe("the seeded demo database (when DATABASE_URL points at one)", () => {
  let demo: { id: string } | null = null;

  beforeAll(async () => {
    try {
      demo = await db.tenant.findUnique({ where: { slug: "demo" }, select: { id: true } });
    } catch {
      demo = null;
    }
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("has no male patient with PCOS, hirsutism or melasma, and no woman on finasteride", async (ctx) => {
    if (!demo) return ctx.skip();
    const patients = await db.patient.findMany({
      where: { tenantId: demo.id },
      select: {
        fullName: true,
        gender: true,
        medicalHistory: { select: { chronicConditions: true, diagnoses: true, symptoms: true } },
        medications: { where: { active: true }, select: { name: true } },
      },
    });
    expect(patients.length).toBeGreaterThan(0);
    const text = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(" · ") : "");
    const wrong = patients.filter((p) => {
      const h = p.medicalHistory;
      if (p.gender === "MALE") return FEMALE_ONLY.test(`${text(h?.chronicConditions)} ${text(h?.diagnoses)}`) || /menstruat/i.test(text(h?.symptoms));
      if (p.gender === "FEMALE") return p.medications.some((m) => /finasteride/i.test(m.name));
      return false;
    });
    expect(wrong.map((p) => p.fullName)).toEqual([]);
  });

  it("has no allergic patient on an active medication their allergy rules out (penicillin vs cephalosporins and the rest)", async (ctx) => {
    if (!demo) return ctx.skip();
    const patients = await db.patient.findMany({
      where: { tenantId: demo.id },
      select: { fullName: true, medicalHistory: { select: { allergies: true } }, medications: { where: { active: true }, select: { name: true } } },
    });
    const conflicts = patients.flatMap((p) => {
      const allergies = Array.isArray(p.medicalHistory?.allergies) ? p.medicalHistory.allergies.filter((a): a is string => typeof a === "string") : [];
      const bad = conflictingMedications(allergies, p.medications.map((m) => m.name));
      return bad.length ? [`${p.fullName}: ${allergies.join(", ")} vs ${bad.join(", ")}`] : [];
    });
    expect(conflicts).toEqual([]);
    const penicillinOnCephalosporin = patients.filter(
      (p) =>
        Array.isArray(p.medicalHistory?.allergies) &&
        (p.medicalHistory.allergies as unknown[]).some((a) => typeof a === "string" && /penicillin/i.test(a)) &&
        p.medications.some((m) => /^(ceph|cef)/i.test(m.name)),
    );
    expect(penicillinOnCephalosporin).toEqual([]);
  });

  it("dictates a penicillin reminder only for patients with the allergy on file, and gendered notes to the right patients", async (ctx) => {
    if (!demo) return ctx.skip();
    const notes = await db.appointmentNote.findMany({
      where: { tenantId: demo.id },
      select: { body: true, patient: { select: { fullName: true, gender: true, medicalHistory: { select: { allergies: true } } } } },
    });
    const wrong = notes.filter((n) => {
      const allergies = JSON.stringify(n.patient.medicalHistory?.allergies ?? []);
      if (/penicillin|البنسلين/i.test(n.body) && !/penicillin/i.test(allergies)) return true;
      if (/\b(she|her)\b|المريضة/.test(n.body) && n.patient.gender === "MALE") return true;
      // "المريض" (the patient, masculine) but not "المريضة" (feminine); \b does not work after Arabic letters.
      if (/\b(he|his)\b|المريض(?!ة)/.test(n.body) && n.patient.gender === "FEMALE") return true;
      return false;
    });
    expect(wrong.map((n) => `${n.patient.fullName}: ${n.body}`)).toEqual([]);
  });
  it("keeps every patient's account adding up: the balance is what is due on invoices, plus what is not invoiced, less the credit", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const patients = await db.patient.findMany({ where: { tenantId }, select: { id: true, fullName: true } });
    expect(patients.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const p of patients) {
      const position = await db.$transaction((tx) => accountPosition(tx, tenantId, [p]));
      if (position.balance !== position.dueOnInvoices + position.notInvoiced - position.credit || position.credit < 0) wrong.push(`${p.fullName}: ${JSON.stringify(position)}`);
    }
    expect(wrong).toEqual([]);
    // Every invoice's status says what was settled on it: the money allocated to it and what was written off.
    const invoices = await db.invoice.findMany({
      where: { tenantId, status: { in: ["ISSUED", "PART_PAID", "PAID"] } },
      select: { number: true, status: true, total: true, allocations: { select: { amount: true } }, writeOffs: { where: { voidedAt: null }, select: { amount: true } } },
    });
    const misstated = invoices.filter((i) => {
      const paid = [...i.allocations, ...i.writeOffs].reduce((s, a) => s + a.amount, 0);
      return i.status !== (paid >= i.total ? "PAID" : paid > 0 ? "PART_PAID" : "ISSUED");
    });
    expect(misstated.map((i) => i.number)).toEqual([]);
  });

  it("has a family account: Hany Nabil pays for his children, and paid towards their invoices", async (ctx) => {
    if (!demo) return ctx.skip();
    const head = await db.patient.findFirstOrThrow({ where: { tenantId: demo.id, fullName: "Hany Nabil" }, select: { id: true, householdMembers: { select: { fullName: true, householdRelation: true } } } });
    expect(head.householdMembers.map((m) => [m.fullName, m.householdRelation]).sort()).toEqual([
      ["Nesma Hany", "CHILD"],
      ["Sherif Hany", "CHILD"],
    ]);
    const paidForThem = await db.paymentAllocation.count({ where: { tenantId: demo.id, payment: { patientId: head.id }, invoice: { patient: { householdHeadId: head.id } } } });
    expect(paidForThem).toBeGreaterThan(0);
  });

  it("takes the desk's money in a shift of its day, counted at the close with the reason for any difference; signs off every day but yesterday and today", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const clinic = await db.clinic.findFirstOrThrow({ where: { tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, timezone: true } });
    const tz = clinic.timezone;
    const today = dateKeyInTz(new Date(), tz);
    const yesterday = dateKeyInTz(new Date(Date.now() - 86_400_000), tz);
    expect(await db.payment.count({ where: { tenantId, deletedAt: null, importBatchId: null, shiftId: null, OR: [{ clinicId: clinic.id }, { clinicId: null }] } })).toBe(0);

    const shifts = await db.cashShift.findMany({
      where: { tenantId },
      select: {
        status: true,
        clinicId: true,
        openingFloat: true,
        openedAt: true,
        counts: true,
        payments: { where: { deletedAt: null }, select: { kind: true, method: true, amount: true, paidAt: true } },
        expensePayments: { where: { voidedAt: null }, select: { method: true, amount: true, paidAt: true } },
      },
    });
    const days = new Set<string>();
    const wrong: string[] = [];
    for (const s of shifts) {
      const day = dateKeyInTz(s.openedAt, tz);
      days.add(day);
      if ([...s.payments, ...s.expensePayments].some((p) => dateKeyInTz(p.paidAt, tz) !== day)) wrong.push(`${day}: money from another day`);
      if (s.expensePayments.some((p) => p.method !== "CASH")) wrong.push(`${day}: an expense paid out of the drawer in something else than cash`);
      if (s.status === "OPEN") {
        if (day !== today) wrong.push(`${day}: still open`);
        continue;
      }
      const expected = new Map<string, number>([["CASH", s.openingFloat]]);
      for (const p of s.payments) expected.set(p.method, (expected.get(p.method) ?? 0) + (p.kind === "REFUND" ? -p.amount : p.amount));
      // Cash paid out of the drawer for expenses.
      for (const p of s.expensePayments) expected.set("CASH", expected.get("CASH")! - p.amount);
      const counts = (s.counts ?? []) as { method: string; expected: number; counted: number; difference: number; reason: string | null }[];
      for (const [method, amount] of expected) {
        const c = counts.find((x) => x.method === method);
        if (!c || c.expected !== amount || c.counted - c.expected !== c.difference) wrong.push(`${day}: ${method} counted against ${c?.expected} for ${amount}`);
        else if (c.difference !== 0 && !c.reason) wrong.push(`${day}: ${method} off by ${c.difference} with no reason`);
      }
    }
    expect(wrong).toEqual([]);
    expect(shifts.filter((s) => s.status === "OPEN").map((s) => dateKeyInTz(s.openedAt, tz))).toEqual([today]);
    expect(shifts.some((s) => (s.counts as { difference: number }[] | null)?.some((c) => c.difference !== 0))).toBe(true);

    const closes = new Set((await db.dayClose.findMany({ where: { tenantId, clinicId: clinic.id }, select: { day: true } })).map((d) => d.day));
    expect([...days].filter((d) => d !== today && d !== yesterday && !closes.has(d))).toEqual([]);
    expect(closes.has(today) || closes.has(yesterday)).toBe(false);
  });

  it("adds every report up the same way over the last year: production from the charges, income from the money, branches and doctors to the totals", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const tz = (await db.clinic.findFirstOrThrow({ where: { tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { timezone: true } })).timezone;
    const scope = await reportScope(tenantId, { period: "custom", from: dateKeyInTz(addDays(new Date(), -365, tz), tz), to: dateKeyInTz(new Date(), tz) });
    const span = { gte: scope.period.from, lt: scope.period.to };
    const [production, income, branches, providers, adjustments, balances, charged, fees, money] = await Promise.all([
      productionReport(scope),
      incomeReport(scope),
      branchReport(scope),
      providersReport(scope),
      adjustmentsReport(scope),
      balancesReport(scope),
      db.charge.aggregate({ where: { tenantId, chargedAt: span }, _sum: { amount: true } }),
      db.payment.aggregate({ where: { tenantId, kind: "CONSULTATION_FEE", deletedAt: null, paidAt: span }, _sum: { amount: true } }),
      db.payment.findMany({ where: { tenantId, deletedAt: null, paidAt: span }, select: { kind: true, amount: true } }),
    ]);
    const t = production.totals;
    expect(t.net).toBe((charged._sum.amount ?? 0) + (fees._sum.amount ?? 0));
    expect(t.gross + t.discounts + t.cancelled + t.fees).toBe(t.net);
    expect(production.days.reduce((s, d) => s + d.net, 0)).toBe(t.net);
    expect(income.totals.net).toBe(money.reduce((s, p) => s + (p.kind === "REFUND" ? -p.amount : p.amount), 0));
    expect(branches.rows.reduce((s, r) => s + r.net, 0)).toBe(t.net);
    expect(branches.totals.income).toBe(income.totals.net);
    expect(providers.rows.reduce((s, r) => s + r.net, 0)).toBe(t.net);
    expect(providers.rows.reduce((s, r) => s + r.collected, 0)).toBe(providers.totals.collected);
    expect(adjustments.totals.DISCOUNT.amount).toBe(t.discounts);
    expect(adjustments.totals.CANCELLED.amount).toBe(t.cancelled);
    // Every balance is due on invoices plus not invoiced, less the credit; the owed and the credit add up.
    expect(balances.rows.filter((r) => r.balance !== r.dueOnInvoices + r.notInvoiced - r.credit).map((r) => r.patientName)).toEqual([]);
    expect(balances.rows.reduce((s, r) => s + Math.max(0, r.balance), 0)).toBe(balances.totals.owed);
    expect(balances.rows.reduce((s, r) => s + r.aging.reduce((x, y) => x + y, 0), 0)).toBe(balances.totals.dueOnInvoices);
  });

  it("closes every day of the last fortnight the same way: the drawer agrees with the books, every receipt traced", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const tz = (await db.clinic.findFirstOrThrow({ where: { tenantId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { timezone: true } })).timezone;
    const problems: string[] = [];
    for (let back = 14; back >= 0; back--) {
      const date = dateKeyInTz(addDays(new Date(), -back, tz), tz);
      const day = await dayCloseReport(await reportScope(tenantId, { report: "day", date }));
      for (const m of day.drawer) if (m.drawer !== m.books - m.paidOut) problems.push(`${date} ${m.method}: drawer ${m.drawer}, payments ${m.books}, paid out ${m.paidOut}`);
      for (const r of day.trace) if (!r.traced) problems.push(`${date} ${r.receiptNumber ?? r.paymentId}: ${r.problem}`);
      if (day.trace.reduce((s, r) => s + r.amount, 0) !== day.income.net) problems.push(`${date}: receipts ${day.trace.length} do not add up to the income`);
    }
    expect(problems).toEqual([]);
    // Every pound collected has its receipt, and no payment paid out more than it brought in.
    expect(await db.payment.count({ where: { tenantId, deletedAt: null, receiptNumber: null } })).toBe(0);
    const over = await db.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM "payments" p JOIN "payment_allocations" a ON a."paymentId" = p.id
      WHERE p."tenantId" = ${tenantId} GROUP BY p.id, p.amount HAVING SUM(a.amount) > p.amount`;
    expect(over).toEqual([]);
  });
  it("recalls each patient once per reason: no doubled review, a booked recall's visit ahead, every ended one dated", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const active = await db.recall.findMany({ where: { tenantId, status: { in: ["OPEN", "CONTACTED", "SNOOZED", "BOOKED"] } }, select: { id: true, patientId: true, ruleId: true, dedupeKey: true, kind: true, procedureId: true, stage: true, status: true, bookedAppointmentId: true } });
    // One rule's review of one day, one course's session, one contact recall at a time per patient.
    const seen = new Map<string, string>();
    const doubled: string[] = [];
    for (const r of active) {
      const key = r.ruleId && r.kind === "REVIEW" ? `${r.patientId}:${r.ruleId}:${r.dedupeKey.split(":").pop()}` : r.kind === "NEXT_SESSION" ? `${r.patientId}:${r.procedureId}:${r.stage}` : ["MISSED", "UNBOOKED", "LAPSED"].includes(r.kind) ? `${r.patientId}:contact` : r.id;
      if (seen.has(key)) doubled.push(`${r.dedupeKey} and ${seen.get(key)}`);
      seen.set(key, r.dedupeKey);
    }
    expect(doubled).toEqual([]);
    // A booked recall's visit is still ahead (or today) and live.
    const booked = active.filter((r) => r.status === "BOOKED");
    const visits = await db.appointment.findMany({ where: { tenantId, id: { in: booked.map((r) => r.bookedAppointmentId!) } }, select: { id: true, status: true, endsAt: true } });
    const live = new Map(visits.map((v) => [v.id, v]));
    expect(booked.filter((r) => !["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"].includes(live.get(r.bookedAppointmentId!)?.status ?? "")).map((r) => r.dedupeKey)).toEqual([]);
    // Ended ones say when, and a decline says why; nobody archived is still being recalled.
    expect(await db.recall.count({ where: { tenantId, status: { in: ["DONE", "DECLINED", "UNREACHABLE"] }, closedAt: null } })).toBe(0);
    expect(await db.recall.count({ where: { tenantId, status: "DECLINED", declineReason: null } })).toBe(0);
    expect(await db.recall.count({ where: { tenantId, status: { in: ["OPEN", "CONTACTED", "SNOOZED", "BOOKED"] }, patient: { deletedAt: { not: null } } } })).toBe(0);
    // Every kind is on the list somewhere, so the demo shows each.
    const kinds = new Set((await db.recall.findMany({ where: { tenantId }, select: { kind: true }, distinct: ["kind"] })).map((r) => r.kind));
    expect([...kinds].sort()).toEqual(["LAPSED", "MISSED", "NEXT_SESSION", "REVIEW", "UNBOOKED"]);
  });

  it("ends every recall: none still waits long after its window with nothing done on it (as seeded)", async (ctx) => {
    if (!demo) return ctx.skip();
    const now = Date.now();
    const forgotten = await db.recall.findMany({
      where: {
        tenantId: demo.id,
        status: { in: ["OPEN", "CONTACTED"] },
        windowEndAt: { lt: new Date(now - END_AFTER_WINDOW_DAYS * 86_400_000) },
        activities: { none: { at: { gt: new Date(now - END_AFTER_SILENT_DAYS * 86_400_000) } } },
      },
      select: { dedupeKey: true },
    });
    expect(forgotten.map((r) => r.dedupeKey)).toEqual([]);
    // And some were ended that way, so the demo shows it.
    expect(await db.recall.count({ where: { tenantId: demo.id, status: "UNREACHABLE", closedById: null } })).toBeGreaterThan(0);
  });

  it("keeps pregnancy on women's records only; a pregnant woman takes nothing to avoid in pregnancy", async (ctx) => {
    if (!demo) return ctx.skip();
    const recorded = await db.patient.findMany({
      where: { tenantId: demo.id, pregnancyStatus: { not: null } },
      select: { fullName: true, gender: true, dateOfBirth: true, pregnancyStatus: true, pregnancyCheckedAt: true, medications: { where: { active: true }, select: { name: true, dosage: true, frequency: true } } },
    });
    expect(recorded.filter((p) => p.gender !== "FEMALE").map((p) => p.fullName)).toEqual([]);
    const now = new Date();
    const pregnant = recorded.filter((p) => pregnancyKnown(p, now) === true);
    expect(pregnant.length).toBeGreaterThan(0);
    const unsafe = pregnant.filter((p) =>
      checkPrescribing({ patient: { gender: "FEMALE", dateOfBirth: p.dateOfBirth, pregnant: true }, allergies: [], conditions: [], activeMedications: [], proposed: p.medications, now }).some((f) => f.rule.startsWith("pregnancy.")),
    );
    expect(unsafe.map((p) => p.fullName)).toEqual([]);
    // An exclusion that counts, and one too old to (the checks ask again).
    expect(recorded.some((p) => pregnancyKnown(p, now) === false)).toBe(true);
    expect(recorded.some((p) => p.pregnancyStatus === "NOT_PREGNANT" && pregnancyKnown(p, now) === null)).toBe(true);
  });

  it("has a library the evidence panel answers from: approved sources in passages, one waiting, one retired, every one marked as demo text", async (ctx) => {
    if (!demo) return ctx.skip();
    const sources = await db.evidenceSource.findMany({ where: { tenantId: demo.id }, select: { title: true, status: true, body: true, publisher: true, _count: { select: { passages: true } } } });
    expect(sources.filter((s) => s.status === "APPROVED").length).toBeGreaterThanOrEqual(5);
    expect(sources.some((s) => s.status === "DRAFT")).toBe(true);
    expect(sources.some((s) => s.status === "RETIRED")).toBe(true);
    expect(sources.filter((s) => !s._count.passages).map((s) => s.title)).toEqual([]);
    // Written for the demo, and saying so: no real publisher's text.
    expect(sources.filter((s) => !/demo|تجريبي/i.test(s.title) || !/demo/i.test(s.publisher ?? "") || !/demo|تجريبي/i.test(s.body.slice(0, 200))).map((s) => s.title)).toEqual([]);

    const passages = await db.evidencePassage.findMany({ where: { tenantId: demo.id, source: { status: "APPROVED" } }, select: { id: true, sourceId: true, heading: true, content: true, source: { select: { title: true } } } });
    const candidates = passages.map((p) => ({ id: p.id, sourceId: p.sourceId, title: p.source.title, heading: p.heading, content: p.content }));
    const cited = (q: string) => answerablePassages(q, candidates).map((c) => `${c.item.title} · ${c.item.heading}`);
    expect(cited("Can doxycycline be given with isotretinoin?")).toEqual(expect.arrayContaining([expect.stringMatching(/^Isotretinoin for acne.* · Do not combine$/)]));
    expect(cited("ينفع دوكسيسيكلين مع روكيوتان؟").length).toBeGreaterThan(0);
    expect(cited("التقشير مع الحمل")).toEqual(expect.arrayContaining([expect.stringMatching(/التقشير الكيميائي.* · الحمل والرضاعة$/)]));
    expect(cited("What dose of tranexamic acid for melasma?")).toEqual([]);
  });

  it("has treatment plans in every state, adding up, numbered in the order they were given; accepted treatments planned at the quoted prices, the unbooked ones on the recall list", async (ctx) => {
    if (!demo) return ctx.skip();
    const tz = "Africa/Cairo";
    const today = dateKeyInTz(new Date(), tz);
    const quotes = await db.quote.findMany({ where: { tenantId: demo.id }, include: { items: { include: { procedure: true } } } });
    const states = new Set(quotes.map((q) => quoteState(q.status, dateKeyInTz(q.validUntil, tz), today)));
    for (const s of ["DRAFT", "SENT", "EXPIRED", "ACCEPTED", "DECLINED", "WITHDRAWN"] as const) expect(states.has(s), s).toBe(true);
    for (const q of quotes) {
      expect(q.total, q.number ?? "draft").toBe(q.items.reduce((sum, i) => sum + i.price - i.discount, 0));
      for (const i of q.items) expect(i.price).toBe(i.unitPrice * i.quantity);
      if (q.status === "ACCEPTED") {
        const accepted = q.items.filter((i) => i.accepted);
        expect(accepted.length).toBeGreaterThan(0);
        expect(q.acceptedTotal).toBe(accepted.reduce((sum, i) => sum + i.price - i.discount, 0));
        for (const i of q.items) {
          if (i.accepted) expect(i.procedure).toMatchObject({ patientId: q.patientId, priceItemId: i.priceItemId, price: i.price, discount: i.discount, quantity: i.quantity, stages: i.stages });
          else expect(i.procedureId).toBeNull();
        }
        expect(cleanSignature(q.signature)).toBe(q.signature);
      } else {
        expect(q.items.every((i) => i.accepted === null && i.procedureId === null)).toBe(true);
      }
    }
    // Numbered when given, in the order they were given: no gaps, no repeats.
    const given = quotes.filter((q) => q.sentAt).sort((a, b) => a.sentAt!.getTime() - b.sentAt!.getTime());
    expect(given.map((q) => q.sequence)).toEqual(given.map((_, i) => i + 1));
    // Every link sent went out in the patient's conversation, the day it was sent.
    for (const q of quotes.filter((x) => x.linkSentAt)) {
      const message = await db.message.findFirst({ where: { tenantId: demo.id, templateKey: "quote:send", meta: { path: ["quoteId"], equals: q.id } }, orderBy: { createdAt: "desc" } });
      expect(message, q.number ?? "").not.toBeNull();
      expect(dateKeyInTz(message!.createdAt, tz)).toBe(dateKeyInTz(q.linkSentAt!, tz));
    }
    // A revision replaced the plan it revised.
    const replaced = quotes.filter((q) => q.status === "WITHDRAWN" && q.withdrawnReason?.startsWith("Replaced by "));
    expect(replaced.length).toBeGreaterThan(0);
    // Accepted and never booked: the recall list has it, naming the plan.
    const unbooked = await db.recall.findMany({ where: { tenantId: demo.id, kind: "UNBOOKED", procedure: { quoteItem: { isNot: null } } }, select: { label: true } });
    expect(unbooked.length).toBeGreaterThan(0);
    expect(unbooked.every((r) => /\(ZAM-QT-\d{6}\), not booked$/.test(r.label))).toBe(true);
  });

  it("has instalment plans for accepted treatment plans (overdue, due this week, paid in full, stopped) whose payments cover them in order; reminders only to patients who agreed, outside the quiet hours", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const tz = "Africa/Cairo";
    const today = dateKeyInTz(new Date(), tz);
    const plans = await db.instalmentPlan.findMany({
      where: { tenantId },
      include: { instalments: { orderBy: { number: "asc" } }, payments: { where: { deletedAt: null } }, quote: { select: { status: true, patientId: true } } },
    });
    expect(plans.length).toBeGreaterThanOrEqual(5);
    const positions = new Map<string, ReturnType<typeof planPosition>>();
    for (const plan of plans) {
      const each = plan.instalments.filter((i) => i.number > 0);
      // The schedule: the down payment, then instalments 1, 2, … in order, adding up to the total.
      expect(plan.instalments.reduce((sum, i) => sum + i.amount, 0), plan.title).toBe(plan.total);
      expect(each.map((i) => i.number)).toEqual(each.map((_, k) => k + 1));
      expect(plan.instalments.find((i) => i.number === 0)?.amount ?? 0).toBe(plan.downPayment);
      expect(each.every((i, k) => k === 0 || i.dueAt > each[k - 1]!.dueAt)).toBe(true);
      if (plan.quote) expect(plan.quote).toEqual({ status: "ACCEPTED", patientId: plan.patientId });
      // The payments cover the instalments in order: those covered in full are stamped paid, the others not.
      const covered = coverInstalments(
        plan.instalments.map((i) => ({ number: i.number, dueKey: dateKeyInTz(i.dueAt, tz), amount: i.amount })),
        netPaid(plan.payments),
        today,
        plan.reminderDays,
      );
      for (const c of covered) expect(Boolean(plan.instalments.find((i) => i.number === c.number)!.paidAt), `${plan.title} #${c.number}`).toBe(c.owed === 0);
      const position = planPosition(plan.total, covered);
      positions.set(plan.id, position);
      if (plan.status === "COMPLETED") expect(position.left).toBe(0);
      if (plan.status === "ACTIVE") expect(position.left).toBeGreaterThan(0);
      if (plan.status === "CANCELLED") expect(Boolean(plan.cancelledAt && plan.cancelReason)).toBe(true);
      expect(plan.payments.every((p) => p.receiptNumber && p.kind !== "CONSULTATION_FEE" && p.patientId === plan.patientId)).toBe(true);
    }
    const active = plans.filter((p) => p.status === "ACTIVE").map((p) => positions.get(p.id)!);
    expect(active.some((p) => p.overdue > 0)).toBe(true);
    expect(active.some((p) => p.overdue === 0 && p.next?.state === "DUE")).toBe(true);
    expect(plans.some((p) => p.status === "COMPLETED")).toBe(true);
    expect(plans.some((p) => p.status === "CANCELLED")).toBe(true);

    // Each message the reminder job sent is the one its instalment was claimed for, to a patient who had agreed, outside the quiet hours.
    const messages = await db.message.findMany({
      where: { tenantId, templateKey: { in: ["instalment:due", "instalment:overdue"] }, author: "SYSTEM" },
      select: { templateKey: true, meta: true, createdAt: true, conversation: { select: { patient: { select: { reminderConsent: true, reminderConsentAt: true } } } } },
    });
    // Every reminder claimed for a patient who had agreed went out: before an instalment's day, and the day after one missed.
    const agreed = new Map((await db.patient.findMany({ where: { tenantId, id: { in: plans.map((p) => p.patientId) } }, select: { id: true, reminderConsent: true, reminderConsentAt: true } })).map((p) => [p.id, p]));
    const agreedAt = (patientId: string, t: Date) => agreed.get(patientId)!.reminderConsent || (agreed.get(patientId)!.reminderConsentAt?.getTime() ?? 0) > t.getTime();
    const claimed = plans.flatMap((p) =>
      p.instalments.flatMap((i) => [
        ...(i.remindedAt ? [{ key: "instalment:due", plan: p.id, number: i.number, at: i.remindedAt, patientId: p.patientId }] : []),
        ...(i.overdueRemindedAt ? [{ key: "instalment:overdue", plan: p.id, number: i.number, at: i.overdueRemindedAt, patientId: p.patientId }] : []),
      ]),
    );
    expect(claimed.some((c) => c.key === "instalment:due")).toBe(true);
    expect(claimed.some((c) => c.key === "instalment:overdue")).toBe(true);
    for (const c of claimed.filter((x) => agreedAt(x.patientId, x.at))) {
      const sent = messages.filter((m) => m.templateKey === c.key && (m.meta as { instalmentPlanId: string }).instalmentPlanId === c.plan && (m.meta as { instalment: number }).instalment === c.number);
      expect(sent.length, `${c.key} ${c.plan} #${c.number}`).toBe(1);
    }
    for (const m of messages) {
      const meta = m.meta as { instalmentPlanId: string; instalment: number };
      const i = plans.find((p) => p.id === meta.instalmentPlanId)?.instalments.find((x) => x.number === meta.instalment);
      expect(i, JSON.stringify(meta)).toBeDefined();
      expect((m.templateKey === "instalment:due" ? i!.remindedAt : i!.overdueRemindedAt)?.getTime()).toBe(m.createdAt.getTime());
      const patient = m.conversation.patient!;
      expect(patient.reminderConsent || (patient.reminderConsentAt?.getTime() ?? 0) > m.createdAt.getTime()).toBe(true);
      expect(isQuiet(m.createdAt, tz, DEFAULT_REMINDER_SETTINGS)).toBe(false);
    }
    expect(await db.notification.count({ where: { tenantId, kind: "INSTALMENT_OVERDUE" } })).toBeGreaterThan(0);
  });

  it("pays two doctors under their rules: statements closed in order, each line what the work earned less what was paid before; last month open to close", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const tz = "Africa/Cairo";
    const rules = await db.doctorPayRule.findMany({ where: { tenantId }, select: { doctorId: true, category: true } });
    const doctorIds = [...new Set(rules.map((r) => r.doctorId))];
    expect(doctorIds).toHaveLength(2);
    for (const d of doctorIds) expect(rules.some((r) => r.doctorId === d && r.category === "*")).toBe(true);
    const statements = await db.doctorStatement.findMany({ where: { tenantId }, orderBy: [{ doctorId: "asc" }, { month: "asc" }], include: { lines: true } });
    const thisMonth = monthOfKey(dateKeyInTz(new Date(), tz));
    for (const d of doctorIds) {
      const mine = statements.filter((s) => s.doctorId === d);
      // Three months back closed (and paid when anything was due), two months back closed and not paid.
      expect(mine.map((s) => s.month)).toEqual([shiftMonth(thisMonth, -3), shiftMonth(thisMonth, -2)]);
      expect(mine[0]!.status).toBe(mine[0]!.payable > 0 ? "PAID" : "CLOSED");
      expect(mine[1]!.status).toBe("CLOSED");
      const paid = new Map<string, number>();
      let carried = 0;
      for (const [i, s] of mine.entries()) {
        if (i > 0) expect(s.month).toBe(shiftMonth(mine[i - 1]!.month, 1));
        expect(s.broughtForward).toBe(carried);
        expect(s.earned).toBe(s.lines.reduce((sum, l) => sum + l.due, 0));
        expect({ payable: s.payable, carriedForward: s.carriedForward }).toEqual(settle(s.earned, s.broughtForward));
        expect(s.status === "PAID").toBe(Boolean(s.paidAt));
        for (const l of s.lines) {
          const key = l.procedureId ?? `f:${l.feeId}`;
          expect(l.paidBefore, `${s.month} ${l.description}`).toBe(paid.get(key) ?? 0);
          expect(l.due).toBe(l.earnedToDate - l.paidBefore);
          paid.set(key, (paid.get(key) ?? 0) + l.due);
        }
        carried = s.carriedForward;
      }
      // Last month is over and open: the owner closes it.
      const last = shiftMonth(monthOfKey(dateKeyInTz(new Date(), tz)), -1);
      const open = await statementFor(tenantId, d, last);
      expect(open).toMatchObject({ status: "OPEN", ended: true, broughtForward: carried });
      expect(open.lines.length).toBeGreaterThan(0);
      expect(open.earned).toBe(open.lines.reduce((sum, l) => sum + l.due, 0));
    }
    // Costs on the work: materials and lab bills, one voided with its reason.
    const costs = await db.procedureCost.findMany({ where: { tenantId }, select: { kind: true, voidedAt: true, voidReason: true } });
    expect(costs.some((c) => c.kind === "LAB")).toBe(true);
    expect(costs.filter((c) => c.voidedAt).every((c) => c.voidReason)).toBe(true);
    expect(costs.some((c) => c.voidedAt)).toBe(true);
  });

  it("keeps the clinic's expenses: recurring bills once a month, payments never past a bill, a late bill, a part-paid one, one voided, the desk's cash in its shifts", async (ctx) => {
    if (!demo) return ctx.skip();
    const tenantId = demo.id;
    const tz = "Africa/Cairo";
    const today = dateKeyInTz(new Date(), tz);
    const expenses = await db.expense.findMany({
      where: { tenantId },
      select: { amount: true, category: true, billedOn: true, dueOn: true, voidedAt: true, voidReason: true, recurringId: true, period: true, supplierId: true, payments: { select: { amount: true, voidedAt: true, shiftId: true } }, files: { select: { id: true } } },
    });
    expect(await db.supplier.count({ where: { tenantId } })).toBeGreaterThanOrEqual(5);
    const wrong: string[] = [];
    let late = 0;
    let part = 0;
    for (const e of expenses) {
      const day = e.billedOn.toISOString().slice(0, 10);
      const paid = e.payments.filter((p) => !p.voidedAt).reduce((sum, p) => sum + p.amount, 0);
      if (paid > e.amount) wrong.push(`${day} ${e.category}: ${paid} paid of ${e.amount}`);
      if (e.voidedAt && (paid || !e.voidReason)) wrong.push(`${day} ${e.category}: voided with money on it or no reason`);
      if (day > today) wrong.push(`${day} ${e.category}: a day ahead`);
      if (!e.voidedAt && paid < e.amount && e.dueOn && e.dueOn.toISOString().slice(0, 10) < today) late += 1;
      if (!e.voidedAt && paid > 0 && paid < e.amount) part += 1;
    }
    expect(wrong).toEqual([]);
    expect(late).toBeGreaterThanOrEqual(1);
    expect(part).toBeGreaterThanOrEqual(1);
    expect(expenses.filter((e) => e.voidedAt)).toHaveLength(1);
    expect(expenses.some((e) => e.category === "SALARIES")).toBe(true);
    expect(expenses.some((e) => e.files.length > 0)).toBe(true);
    // Each recurring expense: one bill a month on its day, none missed since its first.
    const recurring = await db.recurringExpense.findMany({ where: { tenantId }, select: { id: true, startMonth: true, everyMonths: true, dayOfMonth: true } });
    expect(recurring.length).toBeGreaterThanOrEqual(5);
    for (const r of recurring) {
      const periods = expenses.filter((e) => e.recurringId === r.id).map((e) => e.period!).sort();
      const due = recurringMonths(r, monthOfKey(today)).filter((m) => `${m}-${String(r.dayOfMonth).padStart(2, "0")}` <= today);
      expect(periods, r.id).toEqual(due);
    }
    // The desk's cash paid out today is in today's open shift.
    const open = await db.cashShift.findFirstOrThrow({ where: { tenantId, status: "OPEN" }, select: { expensePayments: { select: { amount: true } } } });
    expect(open.expensePayments.length).toBeGreaterThan(0);
  });
});
