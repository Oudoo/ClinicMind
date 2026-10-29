/**
 * The owner's month-by-month reports over the real route and the test
 * database. One clinic with two branches: work done 45 days ago and today, a
 * consultation fee, an invoice part paid and part written off, a company's
 * claim made, sent and part paid through the app's own routes, expenses (one
 * voided), a doctor's statement closed and paid, treatment plans in every
 * state, two instalment plans (one stopped) and a campaign. Every report must
 * add up: profit and loss, owed by age, collection rate, case acceptance,
 * instalments due and revenue by source, overall and at one branch, with the
 * CSV of each; the owner's alone, and each clinic's own.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as reportRoute } from "@/app/api/finance/reports/[report]/route";
import { POST as payersPost } from "@/app/api/payers/route";
import { POST as contractsPost } from "@/app/api/payers/[id]/contracts/route";
import { POST as coverPost } from "@/app/api/patients/[id]/insurance/route";
import { POST as draftRoute } from "@/app/api/invoices/route";
import { POST as issueRoute } from "@/app/api/invoices/[id]/issue/route";
import { POST as batchesPost } from "@/app/api/claim-batches/route";
import { POST as answerPost } from "@/app/api/payer-payments/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const MIN = 60_000;
const DAY = 86_400_000;

describe.skipIf(!dbTestsEnabled)("month-by-month finance report routes", () => {
  const created: string[] = [];
  let a: string;
  let tz: string;
  let zamalek: string;
  let dokki: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let ownerBCookie: string;
  const now = Date.now();
  const old = new Date(now - 45 * DAY);
  const mid = new Date(now - 20 * DAY);
  const recent = new Date(now - 5 * MIN);
  const monthOf = (d: Date) => dateKeyInTz(d, tz).slice(0, 7);
  const keyOf = (d: Date) => dateKeyInTz(d, tz);

  type Json = Record<string, any>;
  const json = async (res: Response) => ({ res, json: (await res.json()) as Json });
  const params = (key: string, value: string) => ({ params: Promise.resolve({ [key]: value }) as Promise<any> });
  const report = async (key: string, query: Record<string, string> = {}, cookie = ownerCookie) =>
    reportRoute(request(`/api/finance/reports/${key}?${new URLSearchParams(query).toString()}`, { cookie }), params("report", key)).then(json);
  const csv = async (key: string, query: Record<string, string> = {}) => {
    const res = await reportRoute(request(`/api/finance/reports/${key}?${new URLSearchParams({ ...query, format: "csv" }).toString()}`, { cookie: ownerCookie }), params("report", key));
    return { res, text: await res.text() };
  };
  const month = (r: Json, d: Date) => (r.months as Json[]).find((m) => m.month === monthOf(d))!;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `mon-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `mon-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    tz = await getTenantTimezone(a);
    zamalek = (await db.clinic.findFirstOrThrow({ where: { tenantId: a }, select: { id: true } })).id;
    dokki = (await db.clinic.create({ data: { tenantId: a, name: "Month Clinic — Dokki" } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner Month" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk Month" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Nadia Month" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    ownerBCookie = await sessionCookieFor((await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" })).id);
    await openShifts(a, [reception.id, owner.id], dokki);
    await ensureDefaultTreatments(a);
    const acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" }, select: { id: true } })).id;

    // Patients: a referral 45 days ago, a campaign's lead 20 days ago, one whose source was never recorded.
    const campaign = await db.campaign.create({ data: { tenantId: a, externalId: "c-month", name: "Meta · Test acne", platform: "META", source: "CLICK_TO_WHATSAPP_AD" } });
    await db.campaignCost.create({ data: { tenantId: a, campaignId: campaign.id, periodStart: new Date(`${keyOf(new Date(now - 40 * DAY))}T00:00:00Z`), periodEnd: new Date(`${keyOf(new Date(now - 31 * DAY))}T00:00:00Z`), amount: 3_000 } });
    const p1 = (await db.patient.create({ data: { tenantId: a, fullName: "Month One", phone: "+201007790001", source: "REFERRAL", createdAt: old } })).id;
    const p2 = (await db.patient.create({ data: { tenantId: a, fullName: "Month Two", phone: "+201007790002", createdAt: mid } })).id;
    await db.lead.create({ data: { tenantId: a, patientId: p2, fullName: "Month Two", source: "CLICK_TO_WHATSAPP_AD", campaignId: campaign.id, stage: "WON", wonAt: mid, createdAt: mid } });
    const p3 = (await db.patient.create({ data: { tenantId: a, fullName: "Month Three", phone: "+201007790003", createdAt: old } })).id;

    // P1 at Zamalek, 45 days ago: 10,000 of work, invoiced, 6,000 paid, 1,000 written off 20 days ago.
    const pr1 = await db.procedure.create({ data: { tenantId: a, patientId: p1, treatmentId: acne, doctorId: doctor.id, performedAt: old, price: 10_000, status: "SIGNED", signedAt: old } });
    const c1 = await db.charge.create({ data: { tenantId: a, patientId: p1, procedureId: pr1.id, amount: 10_000, description: "Acne treatment", chargedAt: old, doctorId: doctor.id, clinicId: zamalek } });
    const i1 = await db.invoice.create({
      data: {
        tenantId: a,
        clinicId: zamalek,
        patientId: p1,
        status: "DRAFT",
        total: 10_000,
        createdById: owner.id,
        lines: { create: { tenantId: a, chargeId: c1.id, description: "Acne treatment", amount: 10_000, chargedAt: old, position: 1 } },
      },
    });
    await db.invoice.update({ where: { id: i1.id }, data: { status: "ISSUED", sequence: 1, number: "MON-INV-000001", issuedAt: old, issuedById: owner.id } });
    await db.invoice.update({ where: { id: i1.id }, data: { status: "PART_PAID" } });
    const py1 = await db.payment.create({ data: { tenantId: a, patientId: p1, kind: "PAYMENT", method: "CASH", amount: 6_000, paidAt: new Date(old.getTime() + 60 * MIN), clinicId: zamalek } });
    await db.paymentAllocation.create({ data: { tenantId: a, paymentId: py1.id, invoiceId: i1.id, amount: 6_000 } });
    await db.writeOff.create({ data: { tenantId: a, patientId: p1, invoiceId: i1.id, amount: 1_000, reason: "BAD_DEBT", writtenOffAt: mid, createdById: owner.id } });
    // P3: a consultation fee at Zamalek 20 days ago.
    await db.payment.create({ data: { tenantId: a, patientId: p3, kind: "CONSULTATION_FEE", method: "CASH", amount: 500, paidAt: mid, clinicId: zamalek } });

    // Expenses: rent at Zamalek (paid), supplies at Dokki today (not paid), one voided.
    await db.expense.create({
      data: {
        tenantId: a,
        clinicId: zamalek,
        category: "RENT",
        description: "Rent",
        billedOn: new Date(`${keyOf(old)}T00:00:00Z`),
        amount: 5_000,
        payments: { create: { tenantId: a, clinicId: zamalek, amount: 5_000, method: "BANK_TRANSFER", paidAt: old } },
      },
    });
    await db.expense.create({ data: { tenantId: a, clinicId: dokki, category: "SUPPLIES", description: "Gloves", billedOn: new Date(`${keyOf(recent)}T00:00:00Z`), amount: 1_200 } });
    await db.expense.create({ data: { tenantId: a, clinicId: zamalek, category: "MARKETING", description: "Flyers", billedOn: new Date(`${keyOf(mid)}T00:00:00Z`), amount: 900, voidedAt: mid, voidReason: "Entered twice" } });

    // The doctor's statement for the month of P1's work: 20% of it billed, 2,000, paid 20 days ago.
    await db.doctorPayRule.create({ data: { tenantId: a, doctorId: doctor.id, basis: "BILLED", rate: 2_000, createdAt: old } });
    const m = monthOf(old);
    const [y, mo] = m.split("-").map(Number) as [number, number];
    const nextMonth = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
    await db.doctorStatement.create({
      data: {
        tenantId: a,
        doctorId: doctor.id,
        month: m,
        periodStart: fromDateKey(`${m}-01`, tz)!,
        periodEnd: fromDateKey(`${nextMonth}-01`, tz)!,
        status: "PAID",
        billed: 10_000,
        collected: 6_000,
        costs: 0,
        earned: 2_000,
        payable: 2_000,
        closedAt: mid,
        paidAt: mid,
        paidMethod: "CASH",
        lines: {
          create: {
            tenantId: a,
            procedureId: pr1.id,
            patientId: p1,
            patientName: "Month One",
            description: "Acne treatment",
            category: "general",
            workAt: old,
            billedToDate: 10_000,
            collectedToDate: 6_000,
            costsToDate: 0,
            sessionsToDate: 1,
            earnedToDate: 2_000,
            paidBefore: 0,
            due: 2_000,
            position: 1,
          },
        },
      },
    });

    // Treatment plans: accepted in part, declined, waiting, expired, withdrawn (left out); one at Dokki with no doctor.
    const quote = (n: number, clinicId: string, data: Record<string, unknown>) =>
      db.quote.create({ data: { tenantId: a, clinicId, patientId: p1, phases: ["Plan"], number: `MON-QT-${n}`, sequence: n, validUntil: new Date(now + 20 * DAY), ...data } as never });
    await quote(1, zamalek, { doctorId: doctor.id, status: "ACCEPTED", total: 4_000, acceptedTotal: 3_000, sentAt: mid, acceptedAt: mid, acceptedName: "Month One", signature: "Month One", acceptedVia: "clinic" });
    await quote(2, zamalek, { doctorId: doctor.id, status: "DECLINED", total: 2_000, sentAt: mid, declinedAt: mid });
    await quote(3, zamalek, { doctorId: doctor.id, status: "SENT", total: 1_000, sentAt: recent });
    await quote(4, zamalek, { doctorId: doctor.id, status: "SENT", total: 500, sentAt: old, validUntil: new Date(old.getTime() + 10 * DAY) });
    await quote(5, zamalek, { doctorId: doctor.id, status: "WITHDRAWN", total: 700, sentAt: mid, withdrawnAt: mid, withdrawnReason: "Replaced" });
    await quote(6, dokki, { status: "ACCEPTED", total: 1_500, acceptedTotal: 1_500, sentAt: recent, acceptedAt: recent, acceptedName: "Month One", signature: "Month One", acceptedVia: "link" });

    // Instalments: P1's plan (the first paid, the second late, one in 10 days, one in 45); P3's, stopped after the first.
    const plan = await db.instalmentPlan.create({
      data: {
        tenantId: a,
        patientId: p1,
        title: "Laser course",
        total: 6_000,
        instalments: {
          create: [
            { tenantId: a, number: 1, dueAt: new Date(now - 40 * DAY), amount: 2_000 },
            { tenantId: a, number: 2, dueAt: new Date(now - 5 * DAY), amount: 2_000 },
            { tenantId: a, number: 3, dueAt: new Date(now + 10 * DAY), amount: 1_000 },
            { tenantId: a, number: 4, dueAt: new Date(now + 45 * DAY), amount: 1_000 },
          ],
        },
      },
    });
    await db.payment.create({ data: { tenantId: a, patientId: p1, kind: "PAYMENT", method: "CASH", amount: 2_000, paidAt: new Date(now - 39 * DAY), clinicId: zamalek, instalmentPlanId: plan.id } });
    const stopped = await db.instalmentPlan.create({
      data: {
        tenantId: a,
        patientId: p3,
        title: "Peels",
        total: 3_000,
        status: "CANCELLED",
        cancelledAt: new Date(now - 10 * DAY),
        cancelReason: "Changed her mind",
        instalments: {
          create: [
            { tenantId: a, number: 1, dueAt: new Date(now - 20 * DAY), amount: 1_500 },
            { tenantId: a, number: 2, dueAt: new Date(now + 20 * DAY), amount: 1_500 },
          ],
        },
      },
    });
    await db.payment.create({ data: { tenantId: a, patientId: p3, kind: "PAYMENT", method: "CASH", amount: 1_500, paidAt: new Date(now - 21 * DAY), clinicId: zamalek, instalmentPlanId: stopped.id } });

    // P2 at Dokki today: a company pays all of it; the claim goes in a batch and the company pays 1,000 of it.
    const pr2 = await db.procedure.create({ data: { tenantId: a, patientId: p2, treatmentId: acne, performedAt: recent, price: 4_000, status: "SIGNED", signedAt: recent } });
    await db.charge.create({ data: { tenantId: a, patientId: p2, procedureId: pr2.id, amount: 4_000, description: "Acne treatment", chargedAt: recent, clinicId: dokki } });
    const payer = (await payersPost(request("/api/payers", { method: "POST", cookie: ownerCookie, body: { name: "Month Fund", kind: "COMPANY", paymentDays: 30 } })).then(json)).json.payer.id as string;
    expect((await contractsPost(request(`/api/payers/${payer}/contracts`, { method: "POST", cookie: ownerCookie, body: { validFrom: keyOf(new Date(now - 60 * DAY)), copayPct: 0, rules: [] } }), params("id", payer)).then(json)).res.status).toBe(201);
    expect((await coverPost(request(`/api/patients/${p2}/insurance`, { method: "POST", cookie: receptionCookie, body: { payerId: payer, memberNumber: "MF-1", validFrom: keyOf(new Date(now - 30 * DAY)) } }), params("id", p2)).then(json)).res.status).toBe(201);
    const drafted = await draftRoute(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId: p2 } })).then(json);
    expect(drafted.res.status, JSON.stringify(drafted.json)).toBe(201);
    const issued = await issueRoute(request(`/api/invoices/${drafted.json.invoice.id}/issue`, { method: "POST", cookie: receptionCookie }), params("id", drafted.json.invoice.id)).then(json);
    expect(issued.json.invoice.claims[0]).toMatchObject({ amount: 4_000 });
    expect((await batchesPost(request("/api/claim-batches", { method: "POST", cookie: receptionCookie, body: { payerId: payer } })).then(json)).res.status).toBe(201);
    const line = await db.claimLine.findFirstOrThrow({ where: { tenantId: a }, select: { id: true } });
    const answered = await answerPost(request("/api/payer-payments", { method: "POST", cookie: ownerCookie, body: { payerId: payer, paidOn: keyOf(new Date()), lines: [{ claimLineId: line.id, paid: 1_000 }] } })).then(json);
    expect(answered.res.status, JSON.stringify(answered.json)).toBe(201);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("adds up the profit and loss month by month: the work done less write-offs, expenses and the doctors' pay; money in and out", async () => {
    const r = (await report("pnl")).json;
    expect(r.months).toHaveLength(12);
    expect(r.months.at(-1).month).toBe(monthOf(new Date()));
    expect(r.totals).toMatchObject({ production: 14_500, writtenOff: 1_000, revenue: 13_500, expenses: 6_200, doctorPay: 2_000, profit: 5_300, moneyIn: 11_000, moneyOut: 7_000 });
    expect(r.totals.byCategory).toEqual({ RENT: 5_000, SUPPLIES: 1_200 });
    expect(r.categories.map((c: Json) => c.key)).toEqual(["RENT", "SUPPLIES"]);
    // The month of P1's work: its 10,000, the rent, the doctor's closed statement.
    expect(month(r, old)).toMatchObject({ production: 10_000 + (monthOf(old) === monthOf(mid) ? 500 : 0), doctorPay: 2_000, doctorPayOpen: false });
    expect(month(r, old).byCategory.RENT).toBe(5_000);
    // Months after the statement are worked out as they stand.
    expect(month(r, new Date()).doctorPayOpen).toBe(true);
    for (const m of r.months as Json[]) expect(m.profit).toBe(m.production - m.writtenOff - m.expenses - m.doctorPay);
    // At one branch: its own work, expenses and doctors' work.
    const z = (await report("pnl", { clinicId: zamalek })).json;
    expect(z.totals).toMatchObject({ production: 10_500, writtenOff: 1_000, expenses: 5_000, doctorPay: 2_000 });
    const d = (await report("pnl", { clinicId: dokki })).json;
    expect(d.totals).toMatchObject({ production: 4_000, writtenOff: 0, expenses: 1_200, doctorPay: 0 });
    // Three months back.
    const short = (await report("pnl", { months: "3" })).json;
    expect(short.months).toHaveLength(3);
  });

  it("shows what is owed now by age: patients by invoice, payers by claim, at one branch too", async () => {
    const r = (await report("owed")).json;
    expect(r.rows.map((x: Json) => [x.name, x.total, x.buckets])).toEqual([
      ["Patients, on their invoices", 3_000, [0, 3_000, 0, 0]],
      ["Month Fund", 3_000, [3_000, 0, 0, 0]],
    ]);
    expect(r.totals).toMatchObject({ total: 6_000, buckets: [3_000, 3_000, 0, 0], late: 0, notSent: 0 });
    expect(r.patients.map((p: Json) => [p.name, p.total, p.invoices])).toEqual([["Month One", 3_000, 1]]);
    expect((await report("owed", { clinicId: zamalek })).json.rows.map((x: Json) => [x.name, x.total])).toEqual([["Patients, on their invoices", 3_000]]);
    expect((await report("owed", { clinicId: dokki })).json.rows.map((x: Json) => [x.name, x.total])).toEqual([
      ["Patients, on their invoices", 0],
      ["Month Fund", 3_000],
    ]);
  });

  it("measures the collection rate of each month's invoices: paid by patients and payers, written off, still owed", async () => {
    const r = (await report("collection")).json;
    expect(r.totals).toMatchObject({ invoices: 2, billed: 14_000, fromPatients: 6_000, fromPayers: 1_000, collected: 7_000, writtenOff: 1_000, payersOwe: 3_000, patientsOwe: 3_000, rate: 50 });
    expect(month(r, old)).toMatchObject({ billed: 10_000, collected: 6_000, writtenOff: 1_000, patientsOwe: 3_000, rate: 60 });
    expect(month(r, new Date())).toMatchObject({ billed: 4_000, fromPayers: 1_000, payersOwe: 3_000, rate: 25 });
    for (const m of r.months as Json[]) expect(m.billed).toBe(m.collected + m.writtenOff + m.payersOwe + m.patientsOwe);
  });

  it("counts case acceptance by month and doctor, a withdrawn plan left out", async () => {
    const r = (await report("acceptance")).json;
    expect(r.totals).toMatchObject({ presented: 5, presentedValue: 9_000, accepted: 2, acceptedValue: 4_500, declined: 1, expired: 1, open: 1, rate: 40, valueRate: 50 });
    expect(r.byDoctor.map((x: Json) => [x.name, x.presented, x.accepted])).toEqual([
      ["Dr. Nadia Month", 4, 1],
      ["No doctor named", 1, 1],
    ]);
    expect((await report("acceptance", { clinicId: dokki })).json.totals).toMatchObject({ presented: 1, accepted: 1 });
  });

  it("lists the instalments falling due: paid, late, the next 30 days and the months ahead; a stopped plan only as far as it was paid", async () => {
    const r = (await report("instalments")).json;
    expect(r).toMatchObject({ activePlans: 1, leftToCollect: 4_000 });
    expect(r.late.map((l: Json) => [l.title, l.number, l.owed])).toEqual([["Laser course", 2, 2_000]]);
    expect(r.next.map((l: Json) => [l.title, l.number, l.owed])).toEqual([["Laser course", 3, 1_000]]);
    expect(r.totals).toMatchObject({ due: 7_500, paid: 3_500, owed: 4_000, late: 2_000 });
    expect(r.months.filter((m: Json) => m.ahead)).toHaveLength(6);
  });

  it("shows the work and money each marketing source brings, and the campaign's cost", async () => {
    const r = (await report("sources")).json;
    expect(r.rows.map((s: Json) => [s.label, s.patients, s.newPatients, s.production, s.collected, s.cost])).toEqual([
      ["Referral", 1, 1, 10_000, 8_000, 0],
      ["Click-to-WhatsApp ad", 1, 1, 4_000, 1_000, 3_000],
      ["Not recorded", 1, 1, 500, 2_000, 0],
    ]);
    expect(r.totals).toMatchObject({ production: 14_500, cost: 3_000 });
    expect(r.campaigns).toEqual([expect.objectContaining({ name: "Meta · Test acne", patients: 1, production: 4_000, cost: 3_000, returnOnCost: 1.3 })]);
    // The work by source adds up to the profit and loss's.
    expect(r.totals.production).toBe((await report("pnl")).json.totals.production);
  });

  it("downloads each as CSV; the owner's alone, and each clinic's own", async () => {
    for (const key of ["pnl", "owed", "collection", "acceptance", "instalments", "sources"]) {
      const { res, text } = await csv(key);
      expect(res.status, key).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(text.split("\n").length, key).toBeGreaterThan(2);
    }
    expect((await csv("pnl")).text).toContain("Total,14500,-1000,13500,-5000,-1200,-6200,-2000,5300");
    expect((await csv("owed")).text).toMatch(/Month One,Patient/);
    expect((await report("pnl", {}, receptionCookie)).res.status).toBe(403);
    const other = (await report("pnl", {}, ownerBCookie)).json;
    expect(other.totals).toMatchObject({ production: 0, expenses: 0, doctorPay: 0 });
    expect((await report("owed", {}, ownerBCookie)).json.totals.total).toBe(0);
  });
});
