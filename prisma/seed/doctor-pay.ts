import type { SeedContext } from "./index";
import { closeStatement, markStatementPaid } from "../../src/modules/finance/doctor-pay";
import { dateKeyInTz, fromDateKey, zonedParts, zonedTimeToUtc } from "../../src/lib/time";
import { monthOfKey, shiftMonth, type PayBasisValue } from "../../src/modules/finance/doctor-pay-calc";

const TZ = "Africa/Cairo";
const HOUR = 3_600_000;

/**
 * Doctor pay in the demo (Phase 5C): the price list's materials per unit;
 * the two doctors' pay rules, set at the start of the month three months
 * back (Dr. Omar a share of what his hair work collects, costs off first;
 * Dr. Mariam a fee per laser session and shares for the rest); the costs of
 * their recent work (transplant materials, PRP kits, one cost voided as
 * entered twice; the labs' bills come from the lab work step); the first
 * month's statements closed and paid, the second's closed and waiting to be
 * paid, the last month left open for the owner to close. Dr. Layla, the owner, has no rules: her work
 * shows on Doctor pay as work no rule pays for. Runs last, once all the
 * work and money is in.
 */

/** Materials used for one unit of each item, in EGP. */
const MATERIALS: Record<string, number> = {
  "FUE-GRAFT": 2,
  "DHI-GRAFT": 3,
  "BEARD-GRAFT": 2,
  "PRP-HAIR": 450,
  "PRP-HAIR-5": 2_250,
  "MESO-HAIR": 250,
  FILLER: 2_200,
  "SKIN-BOOSTER": 1_500,
  "BOTOX-AREA": 900,
  "BOTOX-SWEAT": 1_800,
  "LHR-BODY": 120,
  "LHR-BODY-6": 720,
  "LHR-FACE": 40,
  "LHR-LEGS": 80,
  "LHR-UNDERARM": 40,
  "LHR-UNDERARM-6": 240,
  "LASER-TONING": 80,
  "PEEL-ACNE": 150,
  "PEEL-ACNE-4": 600,
  "PEEL-MELASMA": 180,
  MICRONEEDLE: 300,
  HYDRAFACIAL: 400,
  "ACNE-EXTRACT": 100,
  CRYO: 50,
  "MOLE-RF": 100,
};

interface RuleSpec {
  category: string;
  basis: PayBasisValue;
  /** A share in percent, or a fee a session. */
  value: number;
  deductCosts?: boolean;
  note?: string;
}

const RULES: Record<string, RuleSpec[]> = {
  "doctor@demo.clinic": [
    { category: "hair", basis: "COLLECTED", value: 40, deductCosts: true, note: "Transplants and PRP" },
    { category: "consultation", basis: "FIXED", value: 200 },
    { category: "*", basis: "BILLED", value: 30, deductCosts: true },
  ],
  "mariam@demo.clinic": [
    { category: "laser", basis: "FIXED", value: 250, note: "Per session or area treated" },
    { category: "injectables", basis: "BILLED", value: 35, deductCosts: true },
    { category: "consultation", basis: "FIXED", value: 150 },
    { category: "*", basis: "COLLECTED", value: 35, deductCosts: true },
  ],
};

export async function seedDoctorPay(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const owner = ctx.users.find((u) => u.email === "owner@demo.clinic") ?? ctx.users.find((u) => u.role === "CLINIC_OWNER")!;
  const ownerActor = { id: owner.id, email: owner.email };
  const now = ctx.today;
  const thisMonth = monthOfKey(dateKeyInTz(now, TZ));
  const firstMonth = shiftMonth(thisMonth, -3);
  /** The `day`th of a month at `hour`, clinic clock. */
  const on = (month: string, day: number, hour: number) => {
    const p = zonedParts(fromDateKey(`${month}-01`, TZ)!, TZ);
    return zonedTimeToUtc({ year: p.year, month: p.month, day, hour: Math.floor(hour), minute: Math.round((hour % 1) * 60) }, TZ);
  };

  // The price list's materials.
  for (const [code, materialCost] of Object.entries(MATERIALS)) await db.priceItem.updateMany({ where: { tenantId, code }, data: { materialCost } });

  // The rules, set at the start of the first month.
  const setAt = on(firstMonth, 1, 10);
  let rules = 0;
  for (const [email, specs] of Object.entries(RULES)) {
    const doctor = ctx.users.find((u) => u.email === email);
    if (!doctor) continue;
    for (const r of specs) {
      await db.doctorPayRule.create({
        data: {
          tenantId,
          doctorId: doctor.id,
          category: r.category,
          basis: r.basis,
          rate: r.basis === "FIXED" ? null : Math.round(r.value * 100),
          amount: r.basis === "FIXED" ? r.value : null,
          deductCosts: r.basis === "FIXED" ? false : (r.deductCosts ?? true),
          note: r.note ?? null,
          createdById: owner.id,
          updatedById: owner.id,
          createdAt: setAt,
          updatedAt: setAt,
        },
      });
      rules += 1;
    }
  }

  // The costs of their work since then: each transplant's materials, each PRP kit, one cost entered twice.
  const doctors = Object.keys(RULES).map((email) => ctx.users.find((u) => u.email === email)?.id).filter((id): id is string => Boolean(id));
  const work = await db.procedure.findMany({
    where: { tenantId, doctorId: { in: doctors }, status: "SIGNED", performedAt: { gte: setAt, lt: now }, deletedAt: null },
    orderBy: [{ performedAt: "asc" }, { id: "asc" }],
    select: { id: true, performedAt: true, treatment: { select: { key: true } }, priceItemId: true },
  });
  const cost = (procedureId: string, at: Date, kind: "LAB" | "MATERIAL", description: string, amount: number, voided?: string) =>
    db.procedureCost.create({
      data: {
        tenantId,
        procedureId,
        kind,
        description,
        amount,
        incurredAt: at,
        createdById: owner.id,
        createdAt: at,
        ...(voided ? { voidedAt: new Date(at.getTime() + 26 * HOUR), voidedById: owner.id, voidReason: voided } : {}),
      },
    });
  let costs = 0;
  let twice = false;
  for (const p of work) {
    const at = new Date(p.performedAt.getTime() + 3 * HOUR);
    if (p.priceItemId) continue; // the price list's materials count for it
    if (p.treatment.key === "hair-transplant") {
      await cost(p.id, at, "MATERIAL", "Punches, storage solution and saline", 3_500);
      costs += 1;
      if (!twice) {
        await cost(p.id, new Date(at.getTime() + 10 * 60_000), "MATERIAL", "Punches, storage solution and saline", 3_500, "Entered twice");
        twice = true;
        costs += 1;
      }
    } else if (p.treatment.key === "prp-hair") {
      await cost(p.id, at, "MATERIAL", "PRP kit", 450);
      costs += 1;
    }
  }
  // The labs' bills on the work come from lab orders (the lab work step).

  // The first month's statements closed and paid, the second's closed and waiting; the last month is the owner's to close.
  let closed = 0;
  for (const doctorId of doctors) {
    for (const [k, month] of [firstMonth, shiftMonth(firstMonth, 1)].entries()) {
      const next = shiftMonth(month, 1);
      const s = await closeStatement(tenantId, doctorId, month, ownerActor, { now: on(next, 2, 10) });
      closed += 1;
      if (k === 0 && s.payable > 0) {
        await markStatementPaid(tenantId, doctorId, month, { method: "BANK_TRANSFER", reference: `CIB transfer ${4_400 + closed}`, paidOn: dateKeyInTz(on(next, 5, 11), TZ) }, ownerActor, { now: on(next, 5, 11) });
      }
    }
  }
  console.log(`     ${rules} pay rules, ${costs} procedure costs, ${closed} statements closed`);
}
