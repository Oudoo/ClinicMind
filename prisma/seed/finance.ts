import { randomBytes } from "node:crypto";
import type { PaymentKind, PaymentMethod, Prisma } from "@prisma/client";
import type { SeedContext, SeedPatient } from "./index";
import { makeRandom, type Random } from "./util";

/**
 * Procedures and money for the demo clinic, built on the core seed's
 * appointments:
 *
 * - the last six weeks: a SIGNED procedure for ~70% of the completed
 *   PROCEDURE appointments and some FOLLOW_UP ones (treatment from the
 *   patient's tag, price in the catalogue range, the appointment's doctor and
 *   times), each with its money (a deposit days before for transplant and PRP,
 *   the balance on the day mostly, some balances left outstanding, a few
 *   refunds); consultation fees for ~60% of completed consultations; deposits
 *   on some upcoming procedure bookings; six PLANNED procedures next week;
 * - ~140 older SIGNED procedures over the past two years, paid, so the
 *   repeat-patient rate (M10) has cohorts: of the patients whose first paid
 *   visit falls 12–15 months ago, about a third came back within 12 months.
 *   The cohort's non-returners get no paid visit inside their 12 months, so
 *   the recent appointments that would fall inside it stay unbilled. Ten
 *   long-standing patients go back 18–24 months; the twelve newest
 *   registrations have no history; everyone else's history starts at their
 *   registration. Hair-transplant patients had PRP sessions before; their
 *   transplant is the first procedure booking of the last six weeks.
 *
 * Deterministic (makeRandom(51)); everything goes in with createMany, each
 * signed procedure with its charge. The concierge seed enrols the signed
 * procedures; this module does not call `enrolOnSignedProcedure`.
 */

const DAY = 86_400_000;
const MIN = 60_000;

const TAG_TREATMENT: Record<string, string> = {
  "hair-transplant": "hair-transplant",
  "hair-loss": "prp-hair",
  acne: "acne",
  melasma: "pigmentation",
  pigmentation: "pigmentation",
  laser: "laser-hair-removal",
};
const treatmentKeyFor = (p: Pick<SeedPatient, "tag">) => TAG_TREATMENT[p.tag] ?? "general-dermatology";

const PAY_METHODS: readonly (readonly [PaymentMethod, number])[] = [
  ["CASH", 0.34],
  ["CARD", 0.32],
  ["POS", 0.16],
  ["WALLET", 0.12],
  ["BANK_TRANSFER", 0.06],
];
const DEPOSIT_METHODS: readonly (readonly [PaymentMethod, number])[] = [
  ["BANK_TRANSFER", 0.3],
  ["WALLET", 0.3],
  ["CARD", 0.25],
  ["CASH", 0.15],
];
const FEE_METHODS: readonly (readonly [PaymentMethod, number])[] = [
  ["CASH", 0.5],
  ["CARD", 0.25],
  ["POS", 0.15],
  ["WALLET", 0.1],
];
const KIND_WORD: Record<PaymentKind, string> = { DEPOSIT: "Deposit", PAYMENT: "Payment", REFUND: "Refund", CONSULTATION_FEE: "Consultation fee" };
const METHOD_WORD: Record<PaymentMethod, string> = { CASH: "cash", CARD: "card", BANK_TRANSFER: "bank transfer", WALLET: "wallet", POS: "pos", INSTAPAY: "InstaPay", CHEQUE: "cheque", OTHER: "other" };
const REFUND_NOTES = ["Session shortened — partial refund agreed", "Goodwill refund after a scheduling mix-up", "Package downgraded at the patient's request", "Duplicate card charge reversed"];

/** A cuid-shaped id, so the rows can reference each other inside one createMany. */
const newId = () => `c${randomBytes(12).toString("hex")}`;
const egp = (n: number) => `${n.toLocaleString("en-US")} EGP`;

interface TreatmentInfo {
  id: string;
  key: string;
  name: string;
  priceFrom: number;
  priceTo: number;
  depositAmount: number;
  consultationFee: number;
}

interface AppointmentInfo {
  id: string;
  patientId: string;
  doctorId: string | null;
  kind: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}

function priceFor(t: TreatmentInfo, r: Random): number {
  const step = t.priceTo >= 20_000 ? 500 : 100;
  const raw = t.priceFrom + r.rand() * (t.priceTo - t.priceFrom);
  return Math.max(t.priceFrom, Math.min(t.priceTo, Math.round(raw / step) * step));
}

/** Why a seeded discount was given: from the price, so no random number is drawn (the rest of the demo stays as it was). */
const SEED_DISCOUNT_REASONS = ["LOYALTY", "PROMOTION", "PACKAGE", "FAMILY", "DOCTOR"] as const;
const discountReasonFor = (price: number) => SEED_DISCOUNT_REASONS[Math.floor(price / 50) % SEED_DISCOUNT_REASONS.length]!;

function discountFor(price: number, r: Random): number {
  if (!r.chance(0.15)) return 0;
  const step = price >= 20_000 ? 500 : 50;
  return Math.round((price * (r.between(5, 15) / 100)) / step) * step;
}

/** Choose `share` of the candidates (rounded), skipping the excluded ones, in a deterministic order. */
function sample<T extends { id: string }>(items: readonly T[], share: number, allowed: (item: T) => boolean, r: Random): T[] {
  const target = Math.round(items.length * share);
  const pool = items.filter(allowed).map((item) => ({ item, k: r.rand() }));
  pool.sort((a, b) => a.k - b.k);
  return pool.slice(0, target).map((x) => x.item);
}

export async function seedFinance(ctx: SeedContext): Promise<void> {
  const r = makeRandom(51);
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const nowMs = now.getTime();

  const treatmentRows = await db.treatment.findMany({ where: { tenantId } });
  const treatments = new Map<string, TreatmentInfo>(
    treatmentRows.map((t) => [
      t.key,
      { id: t.id, key: t.key, name: t.name, priceFrom: t.priceFrom ?? 1_000, priceTo: t.priceTo ?? t.priceFrom ?? 2_000, depositAmount: t.depositAmount ?? 0, consultationFee: t.consultationFee ?? 0 },
    ]),
  );
  if (!treatments.size) {
    console.log("     finance: no treatments in the catalogue; skipped.");
    return;
  }
  const treatmentOf = (p: SeedPatient) => treatments.get(treatmentKeyFor(p)) ?? treatments.get("general-dermatology") ?? [...treatments.values()][0]!;

  const patients = new Map(ctx.patients.map((p) => [p.id, p]));
  const patientRows = await db.patient.findMany({ where: { tenantId }, select: { id: true, createdAt: true } });
  const patientCreatedAt = new Map(patientRows.map((p) => [p.id, p.createdAt]));
  const doctorsByKind = {
    hair: ctx.users.filter((u) => u.kind === "hair"),
    derm: ctx.users.filter((u) => u.kind === "derm"),
  };
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? owner;
  const doctorFor = (p: SeedPatient) => r.pick(doctorsByKind[p.doctorKind].length ? doctorsByKind[p.doctorKind] : doctorsByKind.derm.length ? doctorsByKind.derm : [owner]);
  const nameOf = new Map(ctx.users.map((u) => [u.id, u.fullName]));

  const appointments: AppointmentInfo[] = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, startsAt: { gte: new Date(nowMs - 43 * DAY), lt: new Date(nowMs + 22 * DAY) } },
    select: { id: true, patientId: true, doctorId: true, kind: true, status: true, startsAt: true, endsAt: true, createdAt: true },
    orderBy: { startsAt: "asc" },
  });
  const completed = appointments.filter((a) => a.status === "COMPLETED" && a.endsAt.getTime() <= nowMs && patients.has(a.patientId));
  const appointmentById = new Map(appointments.map((a) => [a.id, a]));

  // The CRM seed's won leads became paying patients and its procedure-booked leads have a procedure coming:
  // the first get a signed procedure after their consultation, the second the planned ones (M3, M13).
  const crmLeads = await db.lead.findMany({
    where: { tenantId, deletedAt: null, stage: { in: ["WON", "PROCEDURE_BOOKED"] }, patientId: { not: null } },
    select: { id: true, stage: true, patientId: true, interests: true, wonAt: true, createdAt: true, consultationAppointmentId: true },
    orderBy: { createdAt: "asc" },
  });
  const leadPatients = new Set(crmLeads.map((l) => l.patientId!));

  const procedures: Prisma.ProcedureCreateManyInput[] = [];
  const payments: Prisma.PaymentCreateManyInput[] = [];
  const timeline: Prisma.TimelineEventCreateManyInput[] = [];
  const clamp = (ms: number) => new Date(Math.min(ms, nowMs - 5 * MIN));

  const addPayment = (p: {
    patientId: string;
    kind: PaymentKind;
    method: PaymentMethod;
    amount: number;
    paidAt: Date;
    procedureId?: string | null;
    appointmentId?: string | null;
    reference?: string | null;
    note?: string | null;
    towards?: string | null;
  }) => {
    const id = newId();
    payments.push({
      id,
      tenantId,
      patientId: p.patientId,
      procedureId: p.procedureId ?? null,
      appointmentId: p.appointmentId ?? null,
      kind: p.kind,
      method: p.method,
      amount: p.amount,
      paidAt: p.paidAt,
      reference: p.reference ?? null,
      note: p.note ?? null,
      createdById: p.kind === "REFUND" ? owner.id : reception.id,
      createdAt: p.paidAt,
    });
    timeline.push({
      tenantId,
      patientId: p.patientId,
      kind: "PAYMENT",
      title: `${KIND_WORD[p.kind]} — ${egp(p.amount)} (${METHOD_WORD[p.method]})`,
      body: [p.towards ? `Towards ${p.towards}` : null, p.reference ? `Ref ${p.reference}` : null, p.note].filter(Boolean).join(" · ") || null,
      refId: id,
      occurredAt: p.paidAt,
    });
  };
  let receipt = 4100;
  const ref = (method: PaymentMethod) => (method === "CASH" ? `RCPT-${receipt++}` : method === "BANK_TRANSFER" ? `TRF-${r.between(100_000, 999_999)}` : `POS-${r.between(10_000_000, 99_999_999)}`);

  const signedTimes = new Map<string, number[]>();
  const signedAppointments = new Set<string>();
  /** A signed procedure with its timeline line; returns the id. */
  const addSigned = (p: SeedPatient, t: TreatmentInfo, o: { performedAt: Date; signedAt: Date; doctorId: string | null; appointmentId?: string | null; price?: number; discount?: number }) => {
    const id = newId();
    const price = o.price ?? priceFor(t, r);
    const discount = o.discount ?? discountFor(price, r);
    procedures.push({
      id,
      tenantId,
      patientId: p.id,
      treatmentId: t.id,
      doctorId: o.doctorId,
      appointmentId: o.appointmentId ?? null,
      performedAt: o.performedAt,
      price,
      discount,
      discountReason: discount > 0 ? discountReasonFor(price) : null,
      discountById: discount > 0 ? o.doctorId : null,
      status: "SIGNED",
      signedAt: o.signedAt,
      signedById: o.doctorId,
      createdById: o.doctorId,
      createdAt: new Date(o.performedAt.getTime() - r.between(1, 10) * DAY),
    });
    signedTimes.set(p.id, [...(signedTimes.get(p.id) ?? []), o.performedAt.getTime()]);
    if (o.appointmentId) signedAppointments.add(o.appointmentId);
    const doctor = o.doctorId ? nameOf.get(o.doctorId) : null;
    timeline.push({
      tenantId,
      patientId: p.id,
      kind: "PROCEDURE",
      title: doctor ? `${t.name} performed by Dr ${doctor.replace(/^Dr\.?\s+/i, "")}` : `${t.name} performed`,
      body: egp(price - discount),
      refId: id,
      occurredAt: o.performedAt,
    });
    return { id, net: price - discount };
  };

  /** Deposit days before (transplant, PRP, pigmentation), then the balance: on the day mostly, sometimes in two parts, sometimes left owing. */
  const payFor = (p: SeedPatient, t: TreatmentInfo, proc: { id: string; net: number }, o: { performedAt: Date; endsAt: Date; appointmentId?: string | null; owing?: number; partial?: number }) => {
    let paid = 0;
    if (t.depositAmount > 0 && r.chance(t.key === "pigmentation" ? 0.5 : 0.92)) {
      const method = r.weighted(DEPOSIT_METHODS);
      const dep = Math.min(t.depositAmount, proc.net);
      addPayment({ patientId: p.id, kind: "DEPOSIT", method, amount: dep, paidAt: clamp(o.performedAt.getTime() - r.between(2, 14) * DAY - r.between(0, 300) * MIN), procedureId: proc.id, appointmentId: o.appointmentId ?? null, reference: ref(method), towards: t.name });
      paid += dep;
    }
    const balance = proc.net - paid;
    if (balance <= 0) return;
    const roll = r.rand();
    const owing = o.owing ?? 0.09;
    const partial = o.partial ?? 0.12;
    if (roll < owing) return; // nothing paid yet beyond the deposit
    const dayOf = o.endsAt.getTime() + r.between(5, 40) * MIN;
    if (roll < owing + partial) {
      const part = Math.round((balance * r.between(40, 80)) / 100 / 100) * 100;
      if (part > 0) {
        const method = r.weighted(PAY_METHODS);
        addPayment({ patientId: p.id, kind: "PAYMENT", method, amount: part, paidAt: clamp(dayOf), procedureId: proc.id, reference: ref(method), note: "First instalment", towards: t.name });
      }
      return;
    }
    const method = r.weighted(PAY_METHODS);
    if (t.key === "hair-transplant" && r.chance(0.35)) {
      const first = Math.round((balance * 0.6) / 500) * 500;
      addPayment({ patientId: p.id, kind: "PAYMENT", method, amount: first, paidAt: clamp(dayOf), procedureId: proc.id, reference: ref(method), towards: t.name });
      const secondAt = dayOf + r.between(7, 21) * DAY;
      if (secondAt < nowMs) {
        const m2 = r.weighted(PAY_METHODS);
        addPayment({ patientId: p.id, kind: "PAYMENT", method: m2, amount: balance - first, paidAt: new Date(secondAt), procedureId: proc.id, reference: ref(m2), note: "Second instalment", towards: t.name });
      }
      return;
    }
    addPayment({ patientId: p.id, kind: "PAYMENT", method, amount: balance, paidAt: clamp(dayOf), procedureId: proc.id, reference: ref(method), towards: t.name });
  };

  // ── M10 cohorts: who had their first paid visit 12–15 months ago, and who came back ──
  const dayAt = (offset: number, hour: number, minute = 0) => {
    const d = ctx.calendarDay(offset);
    return ctx.zoned(d.y, d.m, d.d, hour, minute);
  };
  const workday = (offset: number) => (ctx.calendarDay(offset).weekday === 5 ? offset - 1 : offset); // closed on Fridays
  const daysAgo = (d: Date) => Math.floor((nowMs - d.getTime()) / DAY);
  const recentCount = new Map<string, number>();
  for (const a of completed) recentCount.set(a.patientId, (recentCount.get(a.patientId) ?? 0) + 1);

  // The newest registrations have no history: they are this autumn's new patients.
  const byRegistration = [...ctx.patients].sort((a, b) => (patientCreatedAt.get(b.id)?.getTime() ?? 0) - (patientCreatedAt.get(a.id)?.getTime() ?? 0));
  const taken = new Set<string>(byRegistration.slice(0, 12).map((p) => p.id));
  const order = [...ctx.patients].map((p) => ({ p, k: r.rand() })).sort((a, b) => a.k - b.k).map((x) => x.p);
  /** Patient → instant up to which recent paid visits would count as a return (non-returners only). */
  const blockedUntil = new Map<string, number>();
  const firstVisit = new Map<string, Date>();
  const slots: { from: number; to: number; returners: number; stayers: number }[] = [
    { from: -370, to: -366, returners: 1, stayers: 1 }, // the 7-day view's cohort
    { from: -390, to: -372, returners: 3, stayers: 7 }, // with the above: the 28-day and this-month cohorts
    { from: -452, to: -394, returners: 5, stayers: 7 }, // with the above: the 90-day cohort
  ];
  const older: { p: SeedPatient; at: Date }[] = [];
  const visit = (p: SeedPatient, offset: number, first = false) => {
    const at = dayAt(workday(offset), r.between(11, 16), r.pick([0, 30]));
    if (first) firstVisit.set(p.id, at);
    older.push({ p, at });
    return at;
  };
  for (const slot of slots) {
    // Non-returners first, on the patients with the fewest recent visits (their recent visits inside the 12 months stay unbilled).
    for (let i = 0; i < slot.stayers; i++) {
      // Won leads get a procedure after their consultation, so they cannot be the cohort's non-returners.
      const p = order.filter((x) => !taken.has(x.id) && !leadPatients.has(x.id)).sort((a, b) => (recentCount.get(a.id) ?? 0) - (recentCount.get(b.id) ?? 0))[0];
      if (!p) break;
      taken.add(p.id);
      const at = visit(p, r.between(slot.from, slot.to), true);
      blockedUntil.set(p.id, at.getTime() + 366 * DAY);
    }
    for (let i = 0; i < slot.returners; i++) {
      const p = order.find((x) => !taken.has(x.id));
      if (!p) break;
      taken.add(p.id);
      const offset = r.between(slot.from, slot.to);
      visit(p, offset, true);
      const back = offset + r.between(45, 300);
      visit(p, back);
      if (r.chance(0.4)) visit(p, Math.min(-50, back + r.between(30, 120)));
    }
  }
  // Long-standing patients (the earliest registrations): first seen 18–24 months ago, courses of sessions since.
  const remaining = byRegistration.filter((p) => !taken.has(p.id)).reverse();
  const longStanding = remaining.slice(0, 10);
  for (const p of longStanding) {
    taken.add(p.id);
    let cursor = r.between(-728, -548);
    visit(p, cursor, true);
    for (let k = r.between(2, 5); k > 0; k--) {
      cursor += r.between(30, 140);
      if (cursor > -50) break;
      visit(p, cursor);
    }
  }
  // Everyone else: history from their own registration (never inside the cohort windows, so the cohorts stay as designed).
  for (const p of remaining.slice(10)) {
    const created = patientCreatedAt.get(p.id);
    if (!created) continue;
    let cursor = Math.max(-daysAgo(created) + r.between(0, 10), -363);
    if (cursor > -50) continue;
    visit(p, cursor, true);
    for (let k = r.between(0, 2); k > 0; k--) {
      cursor += r.between(30, 120);
      if (cursor > -50) break;
      visit(p, cursor);
    }
  }
  // Top the history up to ~140 procedures with extra sessions for the long-standing patients.
  while (older.length < 140 && longStanding.length) {
    const p = r.pick(longStanding);
    const since = daysAgo(firstVisit.get(p.id)!);
    visit(p, -r.between(50, since - 5));
  }

  // Older procedures: hair-transplant patients had PRP before their transplant (which is recent); paid on the day, a handful still owing.
  older.sort((a, b) => a.at.getTime() - b.at.getTime());
  let oldOwing = 0;
  for (const o of older) {
    let t = treatmentOf(o.p);
    if (t.key === "hair-transplant") t = treatments.get("prp-hair") ?? t;
    const doctorId = doctorFor(o.p).id;
    const endsAt = new Date(o.at.getTime() + 45 * MIN);
    const proc = addSigned(o.p, t, { performedAt: o.at, signedAt: endsAt, doctorId });
    const leaveOwing = oldOwing < 3 && r.chance(0.04);
    if (leaveOwing) oldOwing += 1;
    payFor(o.p, t, proc, { performedAt: o.at, endsAt, owing: leaveOwing ? 1 : 0, partial: 0 });
    if (!leaveOwing && r.chance(0.02)) {
      addPayment({ patientId: o.p.id, kind: "REFUND", method: "CASH", amount: Math.max(100, Math.round((proc.net * 0.2) / 100) * 100), paidAt: new Date(o.at.getTime() + r.between(2, 9) * DAY), procedureId: proc.id, note: r.pick(REFUND_NOTES), towards: t.name });
    }
  }

  // ── The last six weeks ──────────────────────────────────────────────────
  const blocked = (a: AppointmentInfo) => (blockedUntil.get(a.patientId) ?? 0) >= a.startsAt.getTime();
  const procedureAppointments = completed.filter((a) => a.kind === "PROCEDURE");
  const followUps = completed.filter((a) => a.kind === "FOLLOW_UP" && patients.get(a.patientId)?.tag !== "hair-transplant");
  const consultations = completed.filter((a) => a.kind === "CONSULTATION");
  const signedRecent = [
    ...sample(procedureAppointments, 0.7, (a) => !blocked(a), r),
    ...sample(followUps, 0.22, (a) => !blocked(a), r),
  ].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  let refunds = 0;
  const hadTransplant = new Set<string>();
  for (const a of signedRecent) {
    const p = patients.get(a.patientId)!;
    let t = treatmentOf(p);
    if (t.key === "hair-transplant") {
      // One transplant per patient: the first procedure booking; PRP after it.
      if (hadTransplant.has(p.id) || a.kind !== "PROCEDURE") t = treatments.get("prp-hair") ?? t;
      else hadTransplant.add(p.id);
    }
    const proc = addSigned(p, t, { performedAt: a.startsAt, signedAt: a.endsAt, doctorId: a.doctorId, appointmentId: a.id });
    payFor(p, t, proc, { performedAt: a.startsAt, endsAt: a.endsAt, appointmentId: a.id });
    if (refunds < 4 && r.chance(0.05)) {
      const refundAt = a.endsAt.getTime() + r.between(1, 6) * DAY;
      if (refundAt < nowMs) {
        refunds += 1;
        const amount = t.key === "hair-transplant" ? 2_500 : Math.max(100, Math.round((proc.net * r.between(10, 30)) / 100 / 50) * 50);
        addPayment({ patientId: p.id, kind: "REFUND", method: r.pick(["CASH", "CARD", "WALLET"] as const), amount, paidAt: new Date(refundAt), procedureId: proc.id, note: r.pick(REFUND_NOTES), towards: t.name });
      }
    }
  }

  // Won leads: a signed procedure within 60 days of the consultation that converted them (their procedure
  // booking when there is one, else on the day they were won), unless one is already there.
  let wonSigned = 0;
  for (const lead of crmLeads) {
    if (lead.stage !== "WON" || !lead.wonAt || !patients.has(lead.patientId!)) continue;
    const p = patients.get(lead.patientId!)!;
    const consult = lead.consultationAppointmentId ? appointmentById.get(lead.consultationAppointmentId) : undefined;
    const anchor = (consult?.startsAt ?? lead.createdAt).getTime();
    const from = anchor - DAY;
    const to = anchor + 60 * DAY;
    if ((signedTimes.get(p.id) ?? []).some((t) => t >= from && t <= to)) continue;
    const booking = completed.find((a) => a.patientId === p.id && a.kind === "PROCEDURE" && !signedAppointments.has(a.id) && a.startsAt.getTime() >= from && a.startsAt.getTime() <= to);
    const performedAt = booking ? booking.startsAt : new Date(Math.min(lead.wonAt.getTime(), nowMs - 2 * 3_600_000));
    if ((blockedUntil.get(p.id) ?? 0) >= performedAt.getTime()) continue;
    let t = treatments.get(lead.interests[0] ?? "") ?? treatmentOf(p);
    if (t.key === "hair-transplant") {
      if (hadTransplant.has(p.id)) t = treatments.get("prp-hair") ?? t;
      else hadTransplant.add(p.id);
    }
    const endsAt = booking ? booking.endsAt : new Date(performedAt.getTime() + 60 * MIN);
    const doctorId = booking?.doctorId ?? consult?.doctorId ?? doctorFor(p).id;
    const proc = addSigned(p, t, { performedAt, signedAt: endsAt, doctorId, appointmentId: booking?.id ?? null });
    payFor(p, t, proc, { performedAt, endsAt, appointmentId: booking?.id ?? null, owing: 0.05, partial: 0.1 });
    wonSigned += 1;
  }

  // Consultation fees for ~60% of the completed consultations (laser consultations are free).
  const feeFor = (a: AppointmentInfo) => treatmentOf(patients.get(a.patientId)!).consultationFee;
  for (const a of sample(consultations, 0.6, (x) => !blocked(x) && feeFor(x) > 0, r)) {
    const method = r.weighted(FEE_METHODS);
    addPayment({ patientId: a.patientId, kind: "CONSULTATION_FEE", method, amount: feeFor(a), paidAt: new Date(a.startsAt.getTime() - r.between(3, 15) * MIN), appointmentId: a.id, reference: ref(method) });
  }

  // Six procedures planned for next week, on the procedure bookings there (else at 11:00 on a working day).
  const upcoming = appointments.filter((a) => a.startsAt.getTime() > nowMs && (a.status === "SCHEDULED" || a.status === "CONFIRMED") && patients.has(a.patientId));
  const nextWeek = upcoming.filter((a) => a.startsAt.getTime() < nowMs + 8 * DAY);
  // Procedure-booked leads first (on their booking next week, else at 11:00 on a working day next week), then next week's procedure bookings.
  const booked = crmLeads.filter((l) => l.stage === "PROCEDURE_BOOKED" && patients.has(l.patientId!));
  const plans: { a: AppointmentInfo | null; p: SeedPatient; interest: string | null }[] = [];
  for (const lead of booked) {
    if (plans.length >= 6) break;
    const a = upcoming.find((x) => x.patientId === lead.patientId && x.startsAt.getTime() < nowMs + 8 * DAY && !plans.some((pl) => pl.a?.id === x.id)) ?? null;
    plans.push({ a, p: patients.get(lead.patientId!)!, interest: lead.interests[0] ?? null });
  }
  for (const a of [...nextWeek.filter((x) => x.kind === "PROCEDURE"), ...nextWeek.filter((x) => x.kind !== "PROCEDURE")]) {
    if (plans.length >= 6) break;
    if (plans.some((pl) => pl.a?.id === a.id || pl.p.id === a.patientId)) continue;
    plans.push({ a, p: patients.get(a.patientId)!, interest: null });
  }
  const plannedByAppointment = new Map<string, { id: string; treatment: TreatmentInfo; net: number }>();
  for (const plan of plans) {
    const a = plan.a ?? undefined;
    const p = plan.p;
    let t = (plan.interest ? treatments.get(plan.interest) : undefined) ?? treatmentOf(p);
    if (t.key === "hair-transplant" && hadTransplant.has(p.id)) t = treatments.get("prp-hair") ?? t;
    const performedAt = a ? a.startsAt : dayAt(workday(r.between(1, 7)), 11);
    const price = priceFor(t, r);
    const id = newId();
    procedures.push({
      id,
      tenantId,
      patientId: p.id,
      treatmentId: t.id,
      doctorId: a?.doctorId ?? doctorFor(p).id,
      appointmentId: a?.id ?? null,
      performedAt,
      price,
      discount: 0,
      status: "PLANNED",
      notes: r.pick([null, "Quoted at the consultation", "Package price agreed", "Patient asked for a morning slot"]),
      createdById: reception.id,
      createdAt: new Date(nowMs - r.between(1, 6) * DAY),
    });
    if (a) plannedByAppointment.set(a.id, { id, treatment: t, net: price });
  }

  // Deposits on upcoming procedure bookings (and every planned transplant).
  for (const a of upcoming) {
    const p = patients.get(a.patientId)!;
    const planned = plannedByAppointment.get(a.id);
    const t = planned?.treatment ?? treatmentOf(p);
    if (t.depositAmount <= 0) continue;
    const want = planned ? t.key === "hair-transplant" || r.chance(0.6) : a.kind === "PROCEDURE" && r.chance(0.55);
    if (!want) continue;
    const method = r.weighted(DEPOSIT_METHODS);
    const earliest = Math.max(a.createdAt.getTime(), nowMs - 8 * DAY);
    const paidAt = clamp(earliest + r.rand() * Math.max(0, nowMs - earliest));
    addPayment({ patientId: p.id, kind: "DEPOSIT", method, amount: t.depositAmount, paidAt, procedureId: planned?.id ?? null, appointmentId: a.id, reference: ref(method), towards: t.name });
  }

  // Missed procedure bookings where a deposit had been paid (forfeited): the no-show report splits by deposit.
  for (const a of appointments) {
    if (a.status !== "NO_SHOW" || a.kind !== "PROCEDURE" || a.startsAt.getTime() > nowMs || !patients.has(a.patientId)) continue;
    const t = treatmentOf(patients.get(a.patientId)!);
    if (t.depositAmount <= 0 || !r.chance(0.3)) continue;
    const method = r.weighted(DEPOSIT_METHODS);
    addPayment({ patientId: a.patientId, kind: "DEPOSIT", method, amount: t.depositAmount, paidAt: new Date(a.startsAt.getTime() - r.between(2, 9) * DAY), appointmentId: a.id, reference: ref(method), note: "Forfeited after a missed appointment", towards: t.name });
  }

  await db.procedure.createMany({ data: procedures });
  await db.payment.createMany({ data: payments });
  await db.timelineEvent.createMany({ data: timeline });
  // Every signed procedure is charged on the day it was done, as signing does.
  const treatmentName = new Map(treatmentRows.map((t) => [t.id, t.name]));
  await db.charge.createMany({
    data: procedures
      .filter((p) => p.status === "SIGNED")
      .map((p) => ({
        tenantId,
        patientId: p.patientId,
        procedureId: p.id!,
        appointmentId: p.appointmentId ?? null,
        amount: p.price - (p.discount ?? 0),
        description: treatmentName.get(p.treatmentId) ?? "Procedure",
        chargedAt: p.performedAt,
        doctorId: p.doctorId ?? null,
        clinicId: ctx.clinicId,
        createdById: p.signedById ?? null,
        createdAt: p.signedAt ?? p.performedAt,
      })),
  });

  // A patient is registered no later than their first paid visit.
  const earliest = new Map<string, number>();
  const seen = (patientId: string, at: Date) => earliest.set(patientId, Math.min(earliest.get(patientId) ?? Infinity, at.getTime()));
  for (const proc of procedures) if (proc.status === "SIGNED") seen(proc.patientId, proc.performedAt as Date);
  for (const pay of payments) if (pay.kind === "CONSULTATION_FEE") seen(pay.patientId, pay.paidAt as Date);
  const moved: Promise<unknown>[] = [];
  for (const [patientId, first] of earliest) {
    const created = patientCreatedAt.get(patientId);
    if (created && created.getTime() > first) {
      const back = firstVisit.has(patientId) ? r.between(0, 12) : r.between(0, 2);
      moved.push(db.patient.update({ where: { id: patientId }, data: { createdAt: new Date(first - back * DAY) } }));
    }
  }
  await Promise.all(moved);

  const signed = procedures.filter((p) => p.status === "SIGNED").length;
  console.log(
    `     finance: ${signed} signed procedures (${signedRecent.length} on last six weeks' bookings, ${wonSigned} for won leads, ${older.length} older), ${procedures.length - signed} planned, ${payments.length} payments, ${moved.length} registration dates moved to the first paid visit.`,
  );
}
