import type { SeedContext } from "./index";
import { png } from "./util";
import { dateKeyInTz, fromDateKey } from "../../src/lib/time";
import { payExpense } from "../../src/modules/finance/expenses";
import { billLabOrder, cancelLabOrder, createLabOrder, notifyLateLabOrders, recordLabResult } from "../../src/modules/lab/orders";

/**
 * The demo clinic's lab work over its booked weeks: two labs (a pathology
 * lab, seven days; a blood lab, two), biopsies from the doctors' procedures
 * (one benign and billed, one back and flagged for the doctor to act on, one
 * a few days late), a fungal culture, isotretinoin blood checks (one back,
 * one at the lab), pre-op bloods for a hair transplant (one back, one late),
 * a test cancelled. Done through the lab service on their days: the timeline,
 * the doctors' notifications and the late alerts as the clinic would have
 * them. The labs' bills are expenses under Lab fees (the older ones paid by
 * transfer) and costs on the procedures, off the doctors' share; two results
 * wait to be billed.
 */

const TZ = "Africa/Cairo";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A lab report-like placeholder: a letterhead, a table of results, a signature line. */
function reportPhoto(seed: number): Buffer {
  const w = 140;
  const h = 190;
  return png(w, h, (x, y) => {
    if (y < 16) return [32, 92, 110];
    const margin = x < 10 || x > w - 11;
    if (!margin && y > 30 && y < h - 40 && (y - 30) % 14 < 2) return [200, 204, 208];
    if (!margin && y > 30 && y < h - 40 && x > w / 2 && x < w / 2 + 2) return [200, 204, 208];
    const text = !margin && y > 33 && y < h - 40 && (y - 33) % 14 < 4 && (x + seed * 7) % 9 < 6 && x < w - 16;
    if (text) return [90, 94, 98];
    if (y > h - 26 && y < h - 24 && x > w - 60 && x < w - 14) return [40, 40, 40];
    return [252, 252, 250];
  });
}

export async function seedLab(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const today = dateKeyInTz(now, TZ);
  const keyAt = (offset: number) => dateKeyInTz(new Date(now.getTime() + offset * DAY), TZ);
  /** An hour of a day on the clinic clock, never ahead of now. */
  const at = (key: string, hour: number) => new Date(Math.min(now.getTime(), fromDateKey(key, TZ)!.getTime() + hour * HOUR));
  /** Half an hour after a procedure: its sample goes with the lab's courier. */
  const after = (d: Date) => new Date(Math.min(now.getTime(), d.getTime() + HOUR / 2));
  const user = (email: string) => ctx.users.find((u) => u.email === email);
  const owner = user("owner@demo.clinic") ?? ctx.users.find((u) => u.role === "CLINIC_OWNER")!;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? owner;
  const nurse = ctx.users.find((u) => u.role === "NURSE") ?? owner;
  const actor = (u: { id: string; email: string; role: SeedContext["users"][number]["role"] }) => ({ id: u.id, email: u.email, role: u.role });
  const desk = actor(reception);

  // ── The labs ──
  const pathology = await db.supplier.create({
    data: { tenantId, name: "Lotus Pathology", category: "LAB", isLab: true, turnaroundDays: 7, phone: "+20 2 2736 4410", contactName: "Dr. Nahla Shawky", notes: "Histopathology and cultures. Their courier collects samples every day at 2 pm; the month's bills are paid by transfer by the 5th.", createdById: owner.id },
    select: { id: true },
  });
  const bloods = await db.supplier.create({
    data: { tenantId, name: "Mena Medical Lab", category: "LAB", isLab: true, turnaroundDays: 2, phone: "+20 100 233 8150", notes: "Blood tests. The patient goes in with the request; results by e-mail.", createdById: owner.id },
    select: { id: true },
  });

  // The doctors' procedures over the booked weeks, by day.
  const work = await db.procedure.findMany({
    where: { tenantId, deletedAt: null, status: { not: "CANCELLED" }, performedAt: { gte: new Date(now.getTime() - 42 * DAY), lte: now }, doctorId: { not: null } },
    orderBy: [{ performedAt: "asc" }, { id: "asc" }],
    select: { id: true, patientId: true, doctorId: true, status: true, performedAt: true, treatment: { select: { key: true } } },
  });
  const transplants = await db.procedure.findMany({
    where: { tenantId, deletedAt: null, status: { in: ["PLANNED", "SIGNED"] }, treatment: { key: "hair-transplant" }, doctorId: { not: null } },
    // Those still to be done first: pre-op bloods come before the surgery.
    orderBy: [{ status: "asc" }, { performedAt: "desc" }, { id: "asc" }],
    select: { id: true, patientId: true, doctorId: true },
  });
  const used = new Set<string>();
  const dayOf = (d: Date) => dateKeyInTz(d, TZ);
  /** A signed procedure of a treatment between two day offsets, of a patient not used yet. */
  const pick = (key: string, from: number, to: number) => {
    const p = work.find((w) => w.treatment.key === key && w.status === "SIGNED" && dayOf(w.performedAt) >= keyAt(from) && dayOf(w.performedAt) <= keyAt(to) && !used.has(w.patientId));
    if (p) used.add(p.patientId);
    return p;
  };
  const doctorOf = (id: string | null) => ctx.users.find((u) => u.id === id);
  const report = (seed: number) => [{ name: `lab-report-${seed}.png`, type: "image/png", data: reportPhoto(seed).toString("base64") }];

  let orders = 0;
  let billed = 0;
  /** The result, recorded in the morning it came back; the doctor who asked read it that day when it is more than two days old. */
  const result = async (id: string, input: { result: string; abnormal: boolean; files?: ReturnType<typeof report> }, by: ReturnType<typeof actor>, back: string) => {
    const when = at(back, 11);
    const before = new Date();
    await recordLabResult(tenantId, id, { ...input, receivedOn: back }, by, { now: when });
    const old = now.getTime() - when.getTime() > 2 * DAY;
    await db.notification.updateMany({ where: { tenantId, kind: "LAB_RESULT_IN", entityId: id, createdAt: { gte: before } }, data: { createdAt: when, readAt: old ? new Date(when.getTime() + HOUR) : null } });
  };
  /** The lab's bill: in on its day, paid by transfer by the 5th of the next month when that is past. */
  const bill = async (id: string, amount: number, billedOn: string, reference: string) => {
    const due = new Date(new Date(`${billedOn}T00:00:00Z`).getTime());
    due.setUTCMonth(due.getUTCMonth() + 1, 5);
    const dueOn = due.toISOString().slice(0, 10);
    const order = await billLabOrder(tenantId, id, { amount, reference, billedOn, dueOn }, desk, { now: at(billedOn, 16) });
    billed += 1;
    if (dueOn < today && order.bill) await payExpense(tenantId, order.bill.expenseId, { amount, method: "BANK_TRANSFER", paidOn: dueOn, reference: `CIB transfer ${reference.slice(-4)}` }, actor(owner), { now: at(dueOn, 10) });
  };

  // A benign biopsy, back in a week and billed.
  const biopsyA = pick("general-dermatology", -40, -22);
  if (biopsyA) {
    const doctor = doctorOf(biopsyA.doctorId)!;
    const sent = dayOf(biopsyA.performedAt);
    const o = await createLabOrder(tenantId, { patientId: biopsyA.patientId, labId: pathology.id, procedureId: biopsyA.id, doctorId: doctor.id, tests: "Histopathology: shave biopsy of a pigmented lesion", site: "Back, left shoulder blade", reference: "LP-26-4471", sentOn: sent }, actor(doctor), { now: after(biopsyA.performedAt) });
    const back = keyAt(Math.min(0, Math.round((new Date(`${sent}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY) + 6));
    await result(o.id, { result: "Seborrhoeic keratosis, irritated. Benign; completely excised. No further action.", abnormal: false, files: report(1) }, actor(nurse), back);
    await bill(o.id, 1_200, back, "LP-INV-0921");
    orders += 1;
  }
  // A biopsy back and flagged for the doctor to act on, not billed yet.
  const biopsyB = pick("general-dermatology", -18, -9);
  if (biopsyB) {
    const doctor = doctorOf(biopsyB.doctorId)!;
    const sent = dayOf(biopsyB.performedAt);
    const o = await createLabOrder(tenantId, { patientId: biopsyB.patientId, labId: pathology.id, procedureId: biopsyB.id, doctorId: doctor.id, tests: "Histopathology: punch biopsy, 4 mm", site: "Scalp, crown", reference: "LP-26-4630", sentOn: sent }, actor(doctor), { now: after(biopsyB.performedAt) });
    const back = keyAt(Math.min(0, Math.round((new Date(`${sent}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY) + 7));
    await result(o.id, { result: "Lichen planopilaris, active: perifollicular lymphocytic infiltrate with lamellar fibrosis. Treat and review in 6 weeks.", abnormal: true, files: report(2) }, actor(nurse), back);
    orders += 1;
  }
  // A biopsy a few days late.
  const biopsyC = pick("general-dermatology", -13, -9) ?? pick("general-dermatology", -16, -9);
  if (biopsyC) {
    const doctor = doctorOf(biopsyC.doctorId)!;
    await createLabOrder(tenantId, { patientId: biopsyC.patientId, labId: pathology.id, procedureId: biopsyC.id, doctorId: doctor.id, tests: "Histopathology: excision of a skin tag cluster", site: "Neck, right side", reference: "LP-26-4688", sentOn: dayOf(biopsyC.performedAt) }, actor(doctor), { now: after(biopsyC.performedAt) });
    orders += 1;
  }
  // A fungal culture, back and billed.
  const culture = pick("general-dermatology", -30, -14);
  if (culture) {
    const doctor = doctorOf(culture.doctorId)!;
    const sent = dayOf(culture.performedAt);
    const o = await createLabOrder(tenantId, { patientId: culture.patientId, labId: pathology.id, procedureId: culture.id, doctorId: doctor.id, tests: "Fungal culture and KOH of nail clippings", site: "Right great toenail", sentOn: sent }, actor(doctor), { now: after(culture.performedAt) });
    const back = keyAt(Math.min(0, Math.round((new Date(`${sent}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / DAY) + 7));
    await result(o.id, { result: "Trichophyton rubrum grown at 3 weeks; KOH positive. Onychomycosis.", abnormal: false }, actor(doctor), back);
    await bill(o.id, 650, back, "LP-INV-0958");
    orders += 1;
  }
  // Isotretinoin checks at the blood lab: one back, one sent yesterday.
  const acne = work.filter((w) => w.treatment.key === "acne" && w.status === "SIGNED" && !used.has(w.patientId));
  const isoBack = acne.find((w) => dayOf(w.performedAt) <= keyAt(-20));
  if (isoBack) {
    used.add(isoBack.patientId);
    const doctor = doctorOf(isoBack.doctorId)!;
    const sent = keyAt(-19);
    const o = await createLabOrder(tenantId, { patientId: isoBack.patientId, labId: bloods.id, doctorId: doctor.id, tests: "Isotretinoin month 2: fasting lipids, ALT, AST", sentOn: sent }, actor(doctor), { now: at(sent, 13) });
    await result(o.id, { result: "Triglycerides 1.6 mmol/L, cholesterol 4.9 mmol/L, ALT 24 U/L, AST 21 U/L: all within normal limits.", abnormal: false }, actor(doctor), keyAt(-18));
    await bill(o.id, 650, keyAt(-18), "MML-88213");
    orders += 1;
  }
  const isoWaiting = acne.find((w) => !used.has(w.patientId) && w.id !== isoBack?.id);
  if (isoWaiting) {
    used.add(isoWaiting.patientId);
    const doctor = doctorOf(isoWaiting.doctorId)!;
    await createLabOrder(tenantId, { patientId: isoWaiting.patientId, labId: bloods.id, doctorId: doctor.id, tests: "Isotretinoin baseline: fasting lipids, ALT, AST, pregnancy test", sentOn: keyAt(-1) }, actor(doctor), { now: at(keyAt(-1), 13) });
    orders += 1;
  }
  // Pre-op bloods for hair transplants: one back and billed to the transplant, one late.
  const [preOpBack, preOpLate] = transplants.filter((t) => !used.has(t.patientId));
  if (preOpBack) {
    used.add(preOpBack.patientId);
    const doctor = doctorOf(preOpBack.doctorId)!;
    const o = await createLabOrder(tenantId, { patientId: preOpBack.patientId, labId: bloods.id, procedureId: preOpBack.id, doctorId: doctor.id, tests: "Pre-op: CBC, PT/INR, fasting sugar, HBsAg, HCV antibody, HIV", sentOn: keyAt(-15) }, desk, { now: at(keyAt(-15), 10) });
    await result(o.id, { result: "CBC, PT/INR (1.0) and fasting sugar (5.1 mmol/L) normal. HBsAg, HCV antibody and HIV negative. Fit for surgery.", abnormal: false }, actor(nurse), keyAt(-14));
    await bill(o.id, 1_400, keyAt(-14), "MML-88390");
    orders += 1;
  }
  if (preOpLate) {
    used.add(preOpLate.patientId);
    const doctor = doctorOf(preOpLate.doctorId)!;
    await createLabOrder(tenantId, { patientId: preOpLate.patientId, labId: bloods.id, procedureId: preOpLate.id, doctorId: doctor.id, tests: "Pre-op: CBC, PT/INR, fasting sugar, HBsAg, HCV antibody, HIV", sentOn: keyAt(-4) }, desk, { now: at(keyAt(-4), 10) });
    orders += 1;
  }
  // A test done elsewhere, cancelled.
  const elsewhere = acne.find((w) => !used.has(w.patientId));
  if (elsewhere) {
    const doctor = doctorOf(elsewhere.doctorId)!;
    const o = await createLabOrder(tenantId, { patientId: elsewhere.patientId, labId: bloods.id, doctorId: doctor.id, tests: "Vitamin D (25-OH) level", sentOn: keyAt(-8) }, actor(doctor), { now: at(keyAt(-8), 13) });
    await cancelLabOrder(tenantId, o.id, { reason: "The patient had it done at another lab and brought the result." }, desk, { now: at(keyAt(-7), 12) });
    orders += 1;
  }
  // The late ones, told to the doctors and the desk the morning after their day, as the job would have; seen that day when more than two days old.
  let late = 0;
  for (let offset = -42; offset <= 0; offset++) {
    const when = offset === 0 ? now : at(keyAt(offset), 9);
    const before = new Date();
    late += (await notifyLateLabOrders(when, { tenantId })).late;
    const old = now.getTime() - when.getTime() > 2 * DAY;
    await db.notification.updateMany({ where: { tenantId, kind: "LAB_ORDER_LATE", createdAt: { gte: before } }, data: { createdAt: when, readAt: old ? new Date(when.getTime() + HOUR) : null } });
  }
  console.log(`     2 labs, ${orders} lab orders (${late} late, told), ${billed} labs' bills`);
}
