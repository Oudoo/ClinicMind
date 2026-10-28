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
    // Every invoice's status says what was allocated to it.
    const invoices = await db.invoice.findMany({ where: { tenantId, status: { in: ["ISSUED", "PART_PAID", "PAID"] } }, select: { number: true, status: true, total: true, allocations: { select: { amount: true } } } });
    const misstated = invoices.filter((i) => {
      const paid = i.allocations.reduce((s, a) => s + a.amount, 0);
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
});
