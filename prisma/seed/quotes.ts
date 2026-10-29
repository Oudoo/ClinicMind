import type { DiscountReasonValue } from "../../src/modules/finance/constants";
import { acceptQuote, createDraft, declineQuote, getQuote, giveQuote, reviseQuote, sendQuote, updateDraft, withdrawQuote, type Actor } from "../../src/modules/quotes/service";
import { zonedParts, zonedTimeToUtc } from "../../src/lib/time";
import type { SeedContext, SeedPatient } from "./index";

const TZ = "Africa/Cairo";

/**
 * Treatment plans and quotes in the demo (Phase 5), made through the quote
 * service on the days they happened: a hair restoration plan accepted from
 * the link (its treatments are planned procedures nobody has booked yet,
 * which the recall list picks up), an acne plan accepted in part on the
 * clinic's screen, a laser course sent two days ago and waiting, a melasma
 * plan that expired, a hair-loss plan declined with the patient's words, a
 * plan revised before it was accepted (the first one withdrawn), a draft
 * Dr. Omar is still writing, and a dozen more over three months for the
 * case-acceptance figures. Signatures are drawn for the demo.
 */

type Answer =
  | { kind: "draft" }
  | { kind: "open" }
  | { kind: "accept"; daysAfter: number; via: "link" | "clinic"; phases?: number[] }
  | { kind: "decline"; daysAfter: number; reason?: { en: string; ar: string } }
  | { kind: "expire" }
  | { kind: "withdraw"; daysAfter: number; reason: string };

interface PlanSpec {
  /** The scenario of the patient: the next one of it (by name) with no plan yet; else, a man, a woman or anyone with none. */
  cond: string;
  fallback?: "MALE" | "FEMALE" | "ANY";
  /** A patient with nothing booked: what they accept waits on the recall list. */
  unbooked?: true;
  by: "doctor@demo.clinic" | "mariam@demo.clinic" | "owner@demo.clinic" | "reception@demo.clinic";
  doctor: "doctor@demo.clinic" | "mariam@demo.clinic" | "owner@demo.clinic";
  daysAgo: number;
  title: string;
  /** Sent on WhatsApp (else given in print). */
  sent: boolean;
  validDays?: number;
  note?: string;
  phases: { title: string; items: { code: string; quantity?: number; site?: string; discount?: number; reason?: DiscountReasonValue }[] }[];
  answer: Answer;
}

const PLANS: PlanSpec[] = [
  {
    cond: "fue",
    fallback: "MALE",
    unbooked: true,
    by: "doctor@demo.clinic",
    doctor: "doctor@demo.clinic",
    daysAgo: 12,
    title: "Hair restoration plan",
    sent: true,
    note: "The transplant includes the anaesthesia, the first wash at the clinic and the follow-up visits for a year.",
    phases: [
      { title: "The transplant", items: [{ code: "FUE-GRAFT", quantity: 2_500, site: "Hairline and crown" }] },
      { title: "Months 1–6: growth support", items: [{ code: "PRP-HAIR-5", discount: 750, reason: "PACKAGE" }] },
    ],
    answer: { kind: "accept", daysAfter: 2, via: "link" },
  },
  {
    cond: "acne",
    fallback: "ANY",
    unbooked: true,
    by: "mariam@demo.clinic",
    doctor: "mariam@demo.clinic",
    daysAgo: 6,
    title: "Acne and scar plan",
    sent: false,
    phases: [
      { title: "Months 1–3: clear the acne", items: [{ code: "PEEL-ACNE-4" }, { code: "FOLLOW-UP" }] },
      { title: "From month 4: the scars", items: [{ code: "MICRONEEDLE", quantity: 4, site: "Both cheeks", discount: 880, reason: "LOYALTY" }] },
    ],
    answer: { kind: "accept", daysAfter: 0, via: "clinic", phases: [0] },
  },
  {
    cond: "laser-hr",
    fallback: "FEMALE",
    by: "reception@demo.clinic",
    doctor: "mariam@demo.clinic",
    daysAgo: 2,
    title: "Laser hair removal course",
    sent: true,
    phases: [{ title: "Six sessions, six weeks apart", items: [{ code: "LHR-BODY-6", discount: 3_600, reason: "PROMOTION" }, { code: "LHR-FACE", quantity: 1, site: "Upper lip and chin" }] }],
    answer: { kind: "open" },
  },
  {
    cond: "melasma",
    by: "mariam@demo.clinic",
    doctor: "mariam@demo.clinic",
    daysAgo: 40,
    title: "Melasma plan",
    sent: true,
    phases: [{ title: "Three months", items: [{ code: "PEEL-MELASMA", quantity: 3 }, { code: "LASER-TONING", quantity: 4 }] }],
    answer: { kind: "expire" },
  },
  {
    cond: "aga",
    by: "doctor@demo.clinic",
    doctor: "doctor@demo.clinic",
    daysAgo: 9,
    title: "Hair loss plan",
    sent: true,
    phases: [{ title: "Five months", items: [{ code: "PRP-HAIR-5" }, { code: "MESO-HAIR", quantity: 4 }] }],
    answer: { kind: "decline", daysAfter: 2, reason: { en: "I want to try the tablets first, then I will come back.", ar: "أفضل أن أجرب الأقراص أولًا ثم أعود." } },
  },
  // History for the case-acceptance figures: three months of plans and their answers.
  { cond: "fue", by: "doctor@demo.clinic", doctor: "doctor@demo.clinic", daysAgo: 80, title: "Hair restoration plan", sent: true, phases: [{ title: "The transplant", items: [{ code: "FUE-GRAFT", quantity: 3_000, site: "Frontal area" }] }], answer: { kind: "accept", daysAfter: 3, via: "link" } },
  { cond: "fue", by: "doctor@demo.clinic", doctor: "doctor@demo.clinic", daysAgo: 64, title: "Hair restoration plan", sent: true, phases: [{ title: "The transplant", items: [{ code: "DHI-GRAFT", quantity: 2_000, site: "Hairline" }] }, { title: "Growth support", items: [{ code: "PRP-HAIR-5" }] }], answer: { kind: "decline", daysAfter: 5, reason: { en: "Too expensive for now.", ar: "التكلفة عالية بالنسبة لي الآن." } } },
  { cond: "acne", by: "mariam@demo.clinic", doctor: "mariam@demo.clinic", daysAgo: 71, title: "Acne plan", sent: false, phases: [{ title: "Three months", items: [{ code: "PEEL-ACNE-4" }, { code: "ACNE-EXTRACT", quantity: 2 }] }], answer: { kind: "accept", daysAfter: 0, via: "clinic" } },
  { cond: "acne", by: "owner@demo.clinic", doctor: "owner@demo.clinic", daysAgo: 52, title: "Acne scar plan", sent: true, phases: [{ title: "The scars", items: [{ code: "MICRONEEDLE", quantity: 6, site: "Cheeks and temples" }] }], answer: { kind: "expire" } },
  { cond: "laser-hr", fallback: "FEMALE", by: "reception@demo.clinic", doctor: "mariam@demo.clinic", daysAgo: 45, title: "Laser hair removal course", sent: true, phases: [{ title: "Six sessions", items: [{ code: "LHR-UNDERARM-6" }, { code: "LHR-LEGS", quantity: 6, site: "Full legs" }] }], answer: { kind: "accept", daysAfter: 1, via: "link", phases: [0] } },
  { cond: "melasma", fallback: "FEMALE", by: "owner@demo.clinic", doctor: "owner@demo.clinic", daysAgo: 33, title: "Melasma plan", sent: true, phases: [{ title: "Two months", items: [{ code: "PEEL-MELASMA", quantity: 2 }] }], answer: { kind: "accept", daysAfter: 4, via: "link" } },
  { cond: "rosacea", fallback: "ANY", by: "owner@demo.clinic", doctor: "owner@demo.clinic", daysAgo: 27, title: "Skin plan", sent: true, phases: [{ title: "Calm the skin", items: [{ code: "LASER-TONING", quantity: 3 }, { code: "FOLLOW-UP" }] }], answer: { kind: "withdraw", daysAfter: 3, reason: "Dr. Layla changed the plan after the patch test." } },
  { cond: "aga", by: "doctor@demo.clinic", doctor: "doctor@demo.clinic", daysAgo: 18, title: "Hair loss plan", sent: false, phases: [{ title: "Five months", items: [{ code: "PRP-HAIR-5", discount: 750, reason: "LOYALTY" }] }], answer: { kind: "accept", daysAfter: 0, via: "clinic" } },
  { cond: "alopecia-areata", fallback: "ANY", by: "mariam@demo.clinic", doctor: "mariam@demo.clinic", daysAgo: 5, title: "Alopecia areata plan", sent: true, phases: [{ title: "Three months", items: [{ code: "FOLLOW-UP" }, { code: "MESO-HAIR", quantity: 3 }] }], answer: { kind: "open" } },
  { cond: "fue", fallback: "ANY", by: "doctor@demo.clinic", doctor: "doctor@demo.clinic", daysAgo: 0, title: "Beard and hairline", sent: false, phases: [{ title: "The transplant", items: [{ code: "BEARD-GRAFT", quantity: 800, site: "Cheek line" }, { code: "FUE-GRAFT", quantity: 1_200, site: "Temples" }] }], answer: { kind: "draft" } },
];

/** A signature drawn for the demo: a looping scrawl, a little different for each name. */
function demoSignature(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const points: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const x = 40 + i * 12;
    const y = 100 + Math.round(Math.sin(i / (2 + (h % 3))) * (30 + (h % 25))) + ((i * 7 + h) % 11) - 5;
    points.push(`${i === 0 ? "M" : "L"}${Math.min(600, x)},${Math.max(0, Math.min(200, y))}`);
  }
  points.push(`M${60 + (h % 40)},150`, `L${380 + (h % 60)},${140 + (h % 20)}`);
  return points.join(" ");
}

export async function seedQuotes(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const user = (email: string) => {
    const u = ctx.users.find((x) => x.email === email);
    if (!u) throw new Error(`seed user ${email} missing`);
    return u;
  };
  const actorOf = (email: string): Actor => {
    const u = user(email);
    return { id: u.id, email: u.email, role: u.role };
  };
  const items = await db.priceItem.findMany({ where: { tenantId }, select: { id: true, code: true } });
  const itemId = (code: string) => {
    const found = items.find((i) => i.code === code);
    if (!found) throw new Error(`price item ${code} missing`);
    return found.id;
  };
  /** The day `daysAgo` before today, at 11:30 on the clinic clock (and `hours` later), never ahead of now. */
  const at = (daysAgo: number, hours = 0) => {
    const p = zonedParts(new Date(ctx.today.getTime() - daysAgo * 86_400_000), TZ);
    const when = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: 11, minute: 30 }, TZ).getTime() + hours * 3_600_000;
    return new Date(Math.min(when, ctx.today.getTime() - (daysAgo === 0 ? 60_000 * (10 - hours) : 0)));
  };
  const dayKey = (d: Date) => {
    const p = zonedParts(d, TZ);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  };

  // Patients with no treatment plan yet and no work under way, by name: the scenario's first, else a man's, a woman's or anyone's.
  const busy = new Set((await db.procedure.findMany({ where: { tenantId, status: { in: ["PLANNED", "STARTED"] } }, select: { patientId: true } })).map((p) => p.patientId));
  // Booked ahead, or a visit missed or cancelled lately (the recall list has them already).
  const booked = new Set(
    (
      await db.appointment.findMany({
        where: {
          tenantId,
          deletedAt: null,
          OR: [
            { status: { in: ["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "WAITLISTED"] }, endsAt: { gt: ctx.today } },
            { status: { in: ["NO_SHOW", "CANCELLED"] }, startsAt: { gte: new Date(ctx.today.getTime() - 30 * 86_400_000) } },
          ],
        },
        select: { patientId: true },
      })
    ).map((a) => a.patientId),
  );
  const used = new Set<string>();
  const patientFor = (cond: string, fallback?: "MALE" | "FEMALE" | "ANY", unbooked?: boolean): SeedPatient | null => {
    const free = ctx.patients.filter((p) => !busy.has(p.id) && !used.has(p.id)).sort((a, b) => a.fullName.localeCompare(b.fullName));
    const fits = (p: SeedPatient) => p.condKey === cond;
    const fallsBack = (p: SeedPatient) => fallback === "ANY" || p.gender === fallback;
    const chosen =
      (unbooked ? (free.find((p) => fits(p) && !booked.has(p.id)) ?? (fallback ? free.find((p) => fallsBack(p) && !booked.has(p.id)) : undefined)) : undefined) ??
      free.find(fits) ??
      (fallback ? free.find(fallsBack) : undefined) ??
      null;
    if (chosen) used.add(chosen.id);
    return chosen;
  };

  // Everything in the order it happened, so the quote numbers follow the days they were given.
  const steps: { at: Date; run: () => Promise<void> }[] = [];
  let made = 0;
  for (const plan of PLANS) {
    const patient = patientFor(plan.cond, plan.fallback, plan.unbooked);
    if (!patient) continue;
    const by = actorOf(plan.by);
    let id = "";
    const madeAt = at(plan.daysAgo, -1);
    steps.push({
      at: madeAt,
      run: async () => {
        const draft = await createDraft(
          tenantId,
          {
            patientId: patient.id,
            doctorId: user(plan.doctor).id,
            title: plan.title,
            note: plan.note,
            validUntil: dayKey(new Date(madeAt.getTime() + (plan.validDays ?? 30) * 86_400_000)),
            phases: plan.phases.map((ph) => ({
              title: ph.title,
              items: ph.items.map((i) => ({ priceItemId: itemId(i.code), quantity: i.quantity ?? 1, site: i.site, discount: i.discount ?? 0, discountReason: i.reason })),
            })),
          },
          by,
          { now: madeAt },
        );
        id = draft.id;
        made += 1;
        if (plan.answer.kind === "draft") return;
        await give(id, by, plan.sent, at(plan.daysAgo));
      },
    });
    const a = plan.answer;
    if (a.kind === "accept") {
      const when = at(plan.daysAgo - a.daysAfter, a.daysAfter === 0 ? 0.5 : 2);
      steps.push({
        at: when,
        run: async () => {
          const quote = await getQuote(tenantId, id);
          const itemIds = quote.items.filter((i) => !a.phases || a.phases.includes(i.phase)).map((i) => i.id);
          await acceptQuote(tenantId, id, { itemIds, name: patient.fullName, signature: demoSignature(patient.fullName), agree: true }, a.via, a.via === "clinic" ? by : {}, { now: when });
          if (a.via === "link") await dateTheAnswer(id, when);
        },
      });
    } else if (a.kind === "decline") {
      const when = at(plan.daysAgo - a.daysAfter, 4);
      steps.push({
        at: when,
        run: async () => {
          const reason = a.reason ? (patient.language === "ar" ? a.reason.ar : a.reason.en) : undefined;
          await declineQuote(tenantId, id, reason ? { reason } : {}, "link", {}, { now: when });
          await dateTheAnswer(id, when);
        },
      });
    } else if (a.kind === "withdraw") {
      const when = at(plan.daysAgo - a.daysAfter, 1);
      steps.push({ at: when, run: async () => void (await withdrawQuote(tenantId, id, { reason: a.reason }, actorOf("owner@demo.clinic"), { now: when })) });
    }
    // "open" waits; "expire" passes its last valid day on its own.
  }

  // A plan revised before it was accepted: the patient asked for the face instead of the legs; the revision replaced the first one.
  const revised = patientFor("laser-hr", "FEMALE");
  if (revised) {
    const desk = actorOf("reception@demo.clinic");
    let firstId = "";
    let revisionId = "";
    steps.push({
      at: at(20, -1),
      run: async () => {
        const first = await createDraft(
          tenantId,
          {
            patientId: revised.id,
            doctorId: user("mariam@demo.clinic").id,
            title: "Laser hair removal course",
            phases: [{ title: "Six sessions", items: [{ priceItemId: itemId("LHR-UNDERARM-6") }, { priceItemId: itemId("LHR-LEGS"), quantity: 6, site: "Full legs" }] }],
          },
          desk,
          { now: at(20, -1) },
        );
        firstId = first.id;
        made += 1;
        await give(firstId, desk, true, at(20));
      },
    });
    steps.push({
      at: at(16, -1),
      run: async () => {
        const revision = await reviseQuote(tenantId, firstId, desk, { now: at(16, -1) });
        revisionId = revision.id;
        made += 1;
        await updateDraft(
          tenantId,
          revisionId,
          { phases: [{ title: "Six sessions", items: [{ priceItemId: itemId("LHR-UNDERARM-6") }, { priceItemId: itemId("LHR-FACE"), quantity: 1, site: "Upper lip" }] }] },
          desk,
          { now: at(16, -1) },
        );
        await give(revisionId, desk, true, at(16));
      },
    });
    steps.push({
      at: at(15, 3),
      run: async () => {
        const quote = await getQuote(tenantId, revisionId);
        await acceptQuote(tenantId, revisionId, { itemIds: quote.items.map((i) => i.id), name: revised.fullName, signature: demoSignature(revised.fullName), agree: true }, "link", {}, { now: at(15, 3) });
        await dateTheAnswer(revisionId, at(15, 3));
      },
    });
  }

  steps.sort((x, y) => x.at.getTime() - y.at.getTime());
  for (const step of steps) await step.run();
  console.log(`     ${made} treatment plans`);

  /** Given in print, or sent on WhatsApp (the message dated when it went out). */
  async function give(id: string, by: Actor, sent: boolean, when: Date) {
    if (!sent) {
      await giveQuote(tenantId, id, by, { now: when });
      return;
    }
    const out = await sendQuote(tenantId, id, by, { now: when });
    await db.message.update({ where: { id: out.messageId }, data: { createdAt: when } });
  }

  /** The clinic heard of a patient's answer when it came: an old one read already. */
  async function dateTheAnswer(quoteId: string, when: Date) {
    const old = ctx.today.getTime() - when.getTime() > 2 * 86_400_000;
    await db.notification.updateMany({ where: { tenantId, entity: "Quote", entityId: quoteId }, data: { createdAt: when, readAt: old ? new Date(when.getTime() + 3_600_000) : null } });
  }
}
