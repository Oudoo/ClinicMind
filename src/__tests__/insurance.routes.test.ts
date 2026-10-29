/**
 * Insurance and companies (Phase 5) over the real route handlers and the test
 * database: payers and their contracts (no overlap, a new one ends the open
 * one), patients' covers, the contract applied to an invoice (its discount
 * on the draft, the co-pay, approvals and the yearly limit), the claim made
 * at issue settling the payer's share, batches, the payer's answer (paid,
 * refused back to the patient or written off) and its void, cancelling an
 * invoice with its claim, what payers owe by age, the database guards, RBAC
 * and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz } from "@/lib/time";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { payerMoneyIn } from "@/modules/insurance/money";
import { GET as payersGet, POST as payersPost } from "@/app/api/payers/route";
import { GET as payerGet } from "@/app/api/payers/[id]/route";
import { POST as contractsPost } from "@/app/api/payers/[id]/contracts/route";
import { PATCH as contractPatch } from "@/app/api/payer-contracts/[id]/route";
import { GET as insuranceGet, POST as coverPost } from "@/app/api/patients/[id]/insurance/route";
import { POST as approvalPost } from "@/app/api/patients/[id]/approvals/route";
import { POST as approvalAnswer } from "@/app/api/approvals/[id]/answer/route";
import { POST as coverEnd } from "@/app/api/covers/[id]/end/route";
import { GET as claimsGet } from "@/app/api/claims/route";
import { GET as claimGet } from "@/app/api/claims/[id]/route";
import { POST as batchesPost } from "@/app/api/claim-batches/route";
import { GET as batchCsvGet } from "@/app/api/claim-batches/[id]/csv/route";
import { GET as answerContextGet, POST as answerPost } from "@/app/api/payer-payments/route";
import { POST as payerPaymentVoid } from "@/app/api/payer-payments/[id]/void/route";
import { GET as overviewGet } from "@/app/api/insurance/route";
import { POST as invoicesPost } from "@/app/api/invoices/route";
import { GET as invoiceGet } from "@/app/api/invoices/[id]/route";
import { POST as issuePost } from "@/app/api/invoices/[id]/issue/route";
import { POST as cancelPost } from "@/app/api/invoices/[id]/cancel/route";
import { POST as discountPost } from "@/app/api/invoices/[id]/discount/route";
import { POST as paymentsPost } from "@/app/api/payments/route";
import { GET as ledgerGet } from "@/app/api/patients/[id]/ledger/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const dayKey = (offset: number) => dateKeyInTz(new Date(Date.now() + offset * DAY), TZ);

describe.skipIf(!dbTestsEnabled)("insurance and companies routes", () => {
  const created: string[] = [];
  let a: string;
  let branch: string;
  let doctorId: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let payer: string;
  let company: string;
  let mona: string;
  let monaCover: string;
  let consHair: string;
  const treatments = new Map<string, string>();

  type Json = Record<string, any>;
  const json = async (res: Response) => ({ res, json: (await res.json()) as Json });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (handler: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, cookie: string) =>
    handler(request(path, { method: "POST", cookie, body }), params(id)).then(json);

  /** Signed work for a patient with its charge, `daysAgo` days ago. */
  async function work(patientId: string, treatmentKey: string, price: number, daysAgo: number, priceItemId: string | null = null) {
    const at = new Date(Date.now() - daysAgo * DAY);
    const p = await db.procedure.create({ data: { tenantId: a, patientId, treatmentId: treatments.get(treatmentKey)!, priceItemId, doctorId, performedAt: at, price, status: "SIGNED", signedAt: at } });
    const c = await db.charge.create({ data: { tenantId: a, patientId, procedureId: p.id, amount: price, description: `${treatmentKey} work`, chargedAt: at, doctorId, clinicId: branch } });
    return { procedureId: p.id, chargeId: c.id };
  }
  const draft = async (patientId: string, chargeIds?: string[]) => {
    const r = await invoicesPost(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId, ...(chargeIds ? { chargeIds } : {}) } })).then(json);
    expect(r.res.status, JSON.stringify(r.json)).toBe(201);
    return r.json.invoice as Json;
  };
  const issue = async (id: string) => {
    const r = await post(issuePost, `/api/invoices/${id}/issue`, id, {}, receptionCookie);
    expect(r.res.status, JSON.stringify(r.json)).toBe(200);
    return r.json.invoice as Json;
  };
  const invoice = async (id: string) => (await invoiceGet(request(`/api/invoices/${id}`, { cookie: receptionCookie }), params(id)).then(json)).json.invoice as Json;
  const ledger = async (patientId: string) => (await ledgerGet(request(`/api/patients/${patientId}/ledger`, { cookie: receptionCookie }), params(patientId)).then(json)).json;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `ins-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `ins-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a }, select: { id: true } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Covered" });
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" })).id);
    ownerBCookie = await sessionCookieFor((await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" })).id);
    await openShifts(a, [owner.id, reception.id]);
    await ensureDefaultTreatments(a);
    for (const t of await db.treatment.findMany({ where: { tenantId: a }, select: { id: true, key: true } })) treatments.set(t.key, t.id);
    consHair = (await db.priceItem.create({ data: { tenantId: a, code: "CONS-HAIR", name: "Hair consultation", category: "hair", unit: "VISIT", treatmentId: treatments.get("hair-transplant")! } })).id;
    mona = (await db.patient.create({ data: { tenantId: a, fullName: "Mona Insured", phone: "+201007700001" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("the owner adds payers and their contracts; contracts never overlap, a new one ends the open one", async () => {
    const asDesk = await payersPost(request("/api/payers", { method: "POST", cookie: receptionCookie, body: { name: "Nile Shield Insurance", kind: "INSURER" } })).then(json);
    expect(asDesk.res.status).toBe(403);
    const made = await payersPost(request("/api/payers", { method: "POST", cookie: ownerCookie, body: { name: "Nile Shield Insurance", kind: "INSURER", phone: "+20 2 2345 6789", email: "claims@nileshield.example", paymentDays: 45 } })).then(json);
    expect(made.res.status, JSON.stringify(made.json)).toBe(201);
    payer = made.json.payer.id;
    expect((await payersPost(request("/api/payers", { method: "POST", cookie: ownerCookie, body: { name: "nile shield  insurance", kind: "COMPANY" } })).then(json)).res.status).toBe(409);
    const contract = await post(contractsPost, `/api/payers/${payer}/contracts`, payer, {
      reference: "NS-2026-14",
      validFrom: dayKey(-120),
      discountPct: 10,
      copayPct: 20,
      annualLimit: 5_000,
      approvalAbove: 3_000,
      coveredByDefault: true,
      rules: [
        { category: "laser", covered: false },
        { category: "hair", covered: false },
        { priceItemId: consHair, covered: true, copayPct: 10 },
      ],
    }, ownerCookie);
    expect(contract.res.status, JSON.stringify(contract.json)).toBe(201);
    expect(contract.json.payer.contract).toMatchObject({ discountPct: 10, copayPct: 20, annualLimit: 5_000, approvalAbove: 3_000, current: true });
    expect(contract.json.payer.contract.rules).toHaveLength(3);

    company = (await payersPost(request("/api/payers", { method: "POST", cookie: ownerCookie, body: { name: "Papyrus Software House", kind: "COMPANY", paymentDays: 30 } })).then(json)).json.payer.id;
    const first = await post(contractsPost, `/api/payers/${company}/contracts`, company, { validFrom: dayKey(-50), copayPct: 0, rules: [] }, ownerCookie);
    expect(first.res.status).toBe(201);
    // Overlapping days are refused; a contract from a later day ends the open one the day before.
    expect((await post(contractsPost, `/api/payers/${company}/contracts`, company, { validFrom: dayKey(-60), validTo: dayKey(-40), rules: [] }, ownerCookie)).res.status).toBe(409);
    const next = await post(contractsPost, `/api/payers/${company}/contracts`, company, { validFrom: dayKey(10), copayPct: 10, rules: [] }, ownerCookie);
    expect(next.res.status).toBe(201);
    const contracts = (await payerGet(request(`/api/payers/${company}`, { cookie: ownerCookie }), params(company)).then(json)).json.payer.contracts as Json[];
    expect(contracts.map((c) => [c.validFrom, c.validTo, c.current])).toEqual([
      [dayKey(10), null, false],
      [dayKey(-50), dayKey(9), true],
    ]);
    // A contract's terms change for the claims to come.
    const edited = await contractPatch(request(`/api/payer-contracts/${contracts[0]!.id}`, { method: "PATCH", cookie: ownerCookie, body: { validFrom: dayKey(10), copayPct: 15, rules: [{ category: "skin", covered: true, needsApproval: true }] } }), params(contracts[0]!.id)).then(json);
    expect(edited.res.status, JSON.stringify(edited.json)).toBe(200);
    expect(await db.payerRule.count({ where: { tenantId: a, contractId: contracts[0]!.id } })).toBe(1);
    expect((await payersGet(request("/api/payers", { cookie: receptionCookie })).then(json)).json.payers.map((p: Json) => p.name)).toEqual(["Nile Shield Insurance", "Papyrus Software House"]);
  });

  it("the desk adds a patient's cover; one cover on any day; the doctor sees it but not the claims", async () => {
    const asDoctor = await post(coverPost, `/api/patients/${mona}/insurance`, mona, { payerId: payer, memberNumber: "NS-1001", validFrom: dayKey(-100) }, doctorCookie);
    expect(asDoctor.res.status).toBe(403);
    const cover = await post(coverPost, `/api/patients/${mona}/insurance`, mona, { payerId: payer, memberNumber: "NS-1001", plan: "Gold", employer: "Delta Textiles", validFrom: dayKey(-100) }, receptionCookie);
    expect(cover.res.status, JSON.stringify(cover.json)).toBe(201);
    monaCover = cover.json.insurance.current.id;
    expect(cover.json.insurance.current).toMatchObject({ payerName: "Nile Shield Insurance", memberNumber: "NS-1001", relation: "SELF", active: true, terms: { copayPct: 20, discountPct: 10 }, limit: { amount: 5_000, used: 0, left: 5_000 } });
    const twice = await post(coverPost, `/api/patients/${mona}/insurance`, mona, { payerId: company, memberNumber: "PSH-7", validFrom: dayKey(-10) }, receptionCookie);
    expect(twice.res.status).toBe(409);
    const seen = await insuranceGet(request(`/api/patients/${mona}/insurance`, { cookie: doctorCookie }), params(mona)).then(json);
    expect(seen.json.insurance.current.memberNumber).toBe("NS-1001");
    expect(seen.json.insurance.claims).toBeNull();
    expect(await db.timelineEvent.count({ where: { tenantId: a, patientId: mona, kind: "INSURANCE" } })).toBe(1);
  });

  let w1Invoice: string;
  it("a covered patient's invoice takes the contract's discount, and its issue claims the payer's share; the patient owes the rest", async () => {
    const w1 = await work(mona, "general-dermatology", 2_000, 5);
    await work(mona, "laser-hair-removal", 1_500, 5);
    const d = await draft(mona);
    // The contract's discount is on the draft: 10% off the covered work only.
    expect(d.lines.map((l: Json) => l.amount).sort((x: number, y: number) => x - y)).toEqual([-200, 1_500, 2_000]);
    expect(d.total).toBe(3_300);
    const issued = await issue(d.id);
    w1Invoice = issued.id;
    expect(issued.claims).toHaveLength(1);
    expect(issued.claims[0]).toMatchObject({ payerName: "Nile Shield Insurance", memberNumber: "NS-1001", amount: 1_440, status: "OPEN" });
    expect(issued.claims[0].number).toMatch(/-CL-000001$/);
    expect(issued).toMatchObject({ status: "PART_PAID", total: 3_300, claimed: 1_440, paid: 0, due: 1_860 });
    const claim = await db.claim.findFirstOrThrow({ where: { tenantId: a, invoiceId: d.id }, include: { lines: true } });
    expect(claim.lines.map((l) => [l.chargeId, l.amount, l.contractDiscount, l.patientShare, l.payerShare])).toEqual([[w1.chargeId, 1_800, 200, 360, 1_440]]);
    const account = await ledger(mona);
    expect(account.position).toMatchObject({ balance: 1_860, claimed: 1_440 });
    expect(account.entries.find((e: Json) => e.kind === "CLAIMED")).toMatchObject({ credit: 1_440, counterpart: "Nile Shield Insurance", invoiceNumber: issued.number });
    // The patient pays their share: the invoice is paid.
    const paid = await paymentsPost(request("/api/payments", { method: "POST", cookie: receptionCookie, body: { patientId: mona, kind: "PAYMENT", method: "CASH", amount: 1_860 } })).then(json);
    expect(paid.res.status, JSON.stringify(paid.json)).toBe(201);
    expect(await invoice(d.id)).toMatchObject({ status: "PAID", due: 0, paid: 1_860, claimed: 1_440 });
    expect((await ledger(mona)).position.balance).toBe(0);
  });

  let w3: { procedureId: string; chargeId: string };
  let w3Invoice: string;
  it("work that needs the payer's approval is claimed only with one, up to what it approved; the yearly limit caps the rest", async () => {
    w3 = await work(mona, "general-dermatology", 4_000, 3);
    // 3,600 at the contract's price: above the 3,000 that needs an approval, and there is none: the patient's, at the clinic's price.
    const without = await issue((await draft(mona, [w3.chargeId])).id);
    expect(without.claims).toEqual([]);
    expect(without).toMatchObject({ total: 4_000, due: 4_000 });
    expect((await post(cancelPost, `/api/invoices/${without.id}/cancel`, without.id, { reason: "Waiting for the insurer's approval" }, ownerCookie)).res.status).toBe(200);
    const asked = await post(approvalPost, `/api/patients/${mona}/approvals`, mona, { coverageId: monaCover, procedureId: w3.procedureId, description: "Excision and biopsy", amount: 3_600 }, receptionCookie);
    expect(asked.res.status, JSON.stringify(asked.json)).toBe(201);
    const approval = asked.json.insurance.approvals[0];
    expect(approval).toMatchObject({ status: "REQUESTED", amount: 3_600 });
    const answered = await post(approvalAnswer, `/api/approvals/${approval.id}/answer`, approval.id, { status: "APPROVED", approvalNumber: "NS-APR-77", approvedAmount: 2_500, validUntil: dayKey(30) }, receptionCookie);
    expect(answered.res.status, JSON.stringify(answered.json)).toBe(200);
    // Billed again: its contract discount came along, and the approval caps the payer's share.
    const again = await draft(mona, [w3.chargeId]);
    expect(again.total).toBe(3_600);
    const issued = await issue(again.id);
    w3Invoice = issued.id;
    expect(issued.claims[0]).toMatchObject({ amount: 2_500 });
    expect(issued.due).toBe(1_100);
    const line = await db.claimLine.findFirstOrThrow({ where: { tenantId: a, chargeId: w3.chargeId, claim: { status: { not: "CANCELLED" } } } });
    expect(line).toMatchObject({ approvalId: approval.id, payerShare: 2_500, patientShare: 1_100 });
    // 1,440 + 2,500 of the 5,000 taken: 1,060 left for the year.
    const w4 = await work(mona, "general-dermatology", 1_500, 1);
    const capped = await issue((await draft(mona, [w4.chargeId])).id);
    expect(capped.claims[0].amount).toBe(1_060);
    expect(capped.due).toBe(290);
    const view = (await insuranceGet(request(`/api/patients/${mona}/insurance`, { cookie: receptionCookie }), params(mona)).then(json)).json.insurance;
    expect(view.current.limit).toMatchObject({ amount: 5_000, used: 5_000, left: 0 });
    expect(view.approvals[0]).toMatchObject({ approvalNumber: "NS-APR-77", used: 2_500, left: 0 });
    expect(view.claims).toHaveLength(3);
    // The item's own rule covers the hair consultation, its category does not.
    const cons = await work(mona, "hair-transplant", 500, 1, consHair);
    expect((await issue((await draft(mona, [cons.chargeId])).id)).claims).toEqual([]);
  });

  let batchId: string;
  it("sends the claims in a batch; the payer's answer pays, refuses back to the patient, or is written off", async () => {
    const sent = await batchesPost(request("/api/claim-batches", { method: "POST", cookie: receptionCookie, body: { payerId: payer } })).then(json);
    expect(sent.res.status, JSON.stringify(sent.json)).toBe(201);
    expect(sent.json.batches).toHaveLength(1);
    expect(sent.json.batches[0]).toMatchObject({ claims: 3, amount: 5_000 });
    expect(sent.json.batches[0].number).toMatch(/-CB-000001$/);
    batchId = sent.json.batches[0].id;
    expect((await batchesPost(request("/api/claim-batches", { method: "POST", cookie: receptionCookie, body: { payerId: payer } })).then(json)).res.status).toBe(409);
    const csv = await batchCsvGet(request(`/api/claim-batches/${batchId}/csv`, { cookie: receptionCookie }), params(batchId));
    const text = await csv.text();
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(text).toContain("NS-1001");
    expect(text).toContain("NS-APR-77");

    expect((await answerContextGet(request(`/api/payer-payments?payerId=${payer}&batchId=${batchId}`, { cookie: receptionCookie })).then(json)).res.status).toBe(403);
    const lines = (await answerContextGet(request(`/api/payer-payments?payerId=${payer}&batchId=${batchId}`, { cookie: ownerCookie })).then(json)).json.lines as Json[];
    expect(lines.map((l) => l.owed)).toEqual([1_440, 2_500, 1_060]);
    const answer = (body: unknown, cookie = ownerCookie) => answerPost(request("/api/payer-payments", { method: "POST", cookie, body })).then(json);
    const body = {
      payerId: payer,
      batchId,
      paidOn: dayKey(0),
      reference: "NS-REM-1",
      lines: [
        { claimLineId: lines[0]!.id, paid: 1_440 },
        { claimLineId: lines[1]!.id, paid: 2_300, refused: 200, reason: "PRICE" },
        { claimLineId: lines[2]!.id, refused: 1_060, reason: "OVER_LIMIT", writeOff: true },
      ],
    };
    expect((await answer(body, receptionCookie)).res.status).toBe(403);
    expect((await answer({ ...body, lines: [{ claimLineId: lines[0]!.id, paid: 1_441 }] })).res.status).toBe(422);
    expect((await answer({ ...body, lines: [{ claimLineId: lines[0]!.id, refused: 10 }] })).res.status).toBe(422);
    const done = await answer(body);
    expect(done.res.status, JSON.stringify(done.json)).toBe(201);
    expect(done.json.result).toMatchObject({ paid: 3_740, refused: 1_260, writtenOff: 1_060, claims: 3 });
    expect(await db.claim.count({ where: { tenantId: a, batchId, status: "SETTLED" } })).toBe(3);
    // What was refused of the approved work is the patient's again; what was written off is not.
    expect(await invoice(w3Invoice)).toMatchObject({ claimed: 2_300, due: 1_300 });
    const writeOff = await db.writeOff.findFirstOrThrow({ where: { tenantId: a, patientId: mona, reason: "PAYER_REFUSED" } });
    expect(writeOff.amount).toBe(1_060);
    const account = await ledger(mona);
    expect(account.entries.filter((e: Json) => e.kind === "REFUSED").map((e: Json) => [e.debit, e.reason])).toEqual(expect.arrayContaining([[200, "PRICE"], [1_060, "OVER_LIMIT"]]));
    const overview = (await overviewGet(request("/api/insurance", { cookie: receptionCookie })).then(json)).json;
    expect(overview.kpis.owed).toBe(0);
    expect((await payerMoneyIn(db, a, { gte: new Date(Date.now() - DAY) })).reduce((s, m) => s + m.amount, 0)).toBe(3_740);
    const claim = (await claimGet(request(`/api/claims/${lines[1]!.claimId}`, { cookie: receptionCookie }), params(lines[1]!.claimId)).then(json)).json.claim;
    expect(claim.lines[0].answers[0]).toMatchObject({ paid: 2_300, refused: 200, reasonLabel: "Above the contract's price", reference: "NS-REM-1" });
    // Nothing more is owed on a line paid in full.
    expect((await answer({ ...body, lines: [{ claimLineId: lines[0]!.id, paid: 1 }] })).res.status).toBe(422);

    // Voided: the payer owes it again, the write-off goes with it.
    const payment = await db.payerPayment.findFirstOrThrow({ where: { tenantId: a, reference: "NS-REM-1" } });
    expect((await post(payerPaymentVoid, `/api/payer-payments/${payment.id}/void`, payment.id, { reason: "Recorded on the wrong batch" }, receptionCookie)).res.status).toBe(403);
    expect((await post(payerPaymentVoid, `/api/payer-payments/${payment.id}/void`, payment.id, { reason: "Recorded on the wrong batch" }, ownerCookie)).res.status).toBe(200);
    expect(await db.claim.count({ where: { tenantId: a, batchId, status: "SENT" } })).toBe(3);
    expect((await db.writeOff.findUniqueOrThrow({ where: { id: writeOff.id } })).voidedAt).not.toBeNull();
    expect(await invoice(w3Invoice)).toMatchObject({ claimed: 2_500, due: 1_100 });
    expect((await overviewGet(request("/api/insurance", { cookie: receptionCookie })).then(json)).json.kpis.owed).toBe(5_000);
  });

  it("cancels an invoice's claim with it, until the payer has paid any of it", async () => {
    // The insurer's yearly limit is used up: more work for Mona is hers to pay.
    const more = await work(mona, "acne", 1_000, 1);
    expect((await issue((await draft(mona, [more.chargeId])).id)).claims).toEqual([]);
    // A company's staff member: the company pays all of it.
    const karim = (await db.patient.create({ data: { tenantId: a, fullName: "Karim Staff", phone: "+201007700002" } })).id;
    const cover = await post(coverPost, `/api/patients/${karim}/insurance`, karim, { payerId: company, memberNumber: "PSH-7", relation: "SELF", validFrom: dayKey(-20) }, receptionCookie);
    expect(cover.res.status, JSON.stringify(cover.json)).toBe(201);
    const karimCover = cover.json.insurance.current.id;
    const w5 = await work(karim, "acne", 1_000, 1);
    const issued = await issue((await draft(karim, [w5.chargeId])).id);
    expect(issued.claims).toHaveLength(1);
    expect(issued).toMatchObject({ total: 1_000, claimed: 1_000, due: 0, status: "PAID" });
    // A cover's days keep its claims' work: it cannot end before the work it claimed.
    expect((await post(coverEnd, `/api/covers/${karimCover}/end`, karimCover, { endOn: dayKey(-2), reason: "Left the company" }, receptionCookie)).res.status).toBe(409);
    const cancelled = await post(cancelPost, `/api/invoices/${issued.id}/cancel`, issued.id, { reason: "Wrong patient" }, ownerCookie);
    expect(cancelled.res.status, JSON.stringify(cancelled.json)).toBe(200);
    expect((await db.claim.findFirstOrThrow({ where: { tenantId: a, invoiceId: issued.id } })).status).toBe("CANCELLED");
    expect((await ledger(karim)).entries.filter((e: Json) => e.kind === "CLAIMED")).toEqual([]);
    // Its claim cancelled, the cover can end.
    const ended = await post(coverEnd, `/api/covers/${karimCover}/end`, karimCover, { endOn: dayKey(-2), reason: "Left the company" }, receptionCookie);
    expect(ended.res.status, JSON.stringify(ended.json)).toBe(200);
    expect(ended.json.insurance.current).toBeNull();
    // Paid by the payer: the invoice stays.
    const line = await db.claimLine.findFirstOrThrow({ where: { tenantId: a, claim: { invoiceId: w1Invoice } } });
    expect((await answerPost(request("/api/payer-payments", { method: "POST", cookie: ownerCookie, body: { payerId: payer, paidOn: dayKey(0), lines: [{ claimLineId: line.id, paid: 1_440 }] } })).then(json)).res.status).toBe(201);
    const refused = await post(cancelPost, `/api/invoices/${w1Invoice}/cancel`, w1Invoice, { reason: "Typo" }, ownerCookie);
    expect(refused.res.status).toBe(409);
    expect(refused.json.error).toBe("claim_paid");
  });

  it("shows what each payer owes by age, and keeps claims and answers as they were written", async () => {
    const overview = (await overviewGet(request("/api/insurance", { cookie: ownerCookie })).then(json)).json;
    const row = overview.aging.rows.find((r: Json) => r.payerId === payer);
    expect(row).toMatchObject({ total: 3_560, notSent: 0, overdue: 0 });
    expect(row.buckets.d30).toBe(3_560);
    expect(overview.kpis.toSend.claims).toBe(0);
    const list = (await claimsGet(request("/api/claims?view=sent", { cookie: receptionCookie })).then(json)).json.claims;
    expect(list.rows).toHaveLength(2);
    expect(list.totals.owed).toBe(3_560);

    const claim = await db.claim.findFirstOrThrow({ where: { tenantId: a, invoiceId: w1Invoice }, include: { lines: { include: { answers: true } } } });
    await expect(db.claim.delete({ where: { id: claim.id } })).rejects.toThrow();
    await expect(db.claim.update({ where: { id: claim.id }, data: { amount: 1 } })).rejects.toThrow();
    await expect(db.claimLine.update({ where: { id: claim.lines[0]!.id }, data: { payerShare: 1_000 } })).rejects.toThrow();
    await expect(db.claimAnswer.update({ where: { id: claim.lines[0]!.answers[0]!.id }, data: { paid: 1 } })).rejects.toThrow();
    // Never more than the payer's share, whoever writes it.
    const extra = await db.payerPayment.create({ data: { tenantId: a, payerId: payer, amount: 1, paidAt: new Date() } });
    await expect(db.claimAnswer.create({ data: { tenantId: a, claimLineId: claim.lines[0]!.id, payerPaymentId: extra.id, paid: 1 } })).rejects.toThrow(/no more than/);
  });

  it("keeps each clinic's payers and claims to itself, and the assistant out", async () => {
    expect((await payerGet(request(`/api/payers/${payer}`, { cookie: ownerBCookie }), params(payer)).then(json)).res.status).toBe(404);
    expect((await claimsGet(request("/api/claims?view=all", { cookie: ownerBCookie })).then(json)).json.claims.rows).toEqual([]);
    expect((await claimsGet(request("/api/claims", { cookie: assistantCookie })).then(json)).res.status).toBe(403);
    expect((await claimsGet(request("/api/claims", { cookie: doctorCookie })).then(json)).res.status).toBe(403);
    expect((await post(coverPost, `/api/patients/${mona}/insurance`, mona, { payerId: payer, memberNumber: "X", validFrom: dayKey(0) }, ownerBCookie)).res.status).toBe(404);
  });

  it("takes the contract's discount off what the desk's discount leaves, whichever came first", async () => {
    const fund = (await payersPost(request("/api/payers", { method: "POST", cookie: ownerCookie, body: { name: "Delta Staff Fund", kind: "COMPANY", paymentDays: 30 } })).then(json)).json.payer.id;
    expect((await post(contractsPost, `/api/payers/${fund}/contracts`, fund, { validFrom: dayKey(-30), discountPct: 20, copayPct: 10, rules: [] }, ownerCookie)).res.status).toBe(201);
    const hala = (await db.patient.create({ data: { tenantId: a, fullName: "Hala Member", phone: "+201007700003" } })).id;
    expect((await post(coverPost, `/api/patients/${hala}/insurance`, hala, { payerId: fund, memberNumber: "DSF-3", validFrom: dayKey(-30) }, receptionCookie)).res.status).toBe(201);
    const w6 = await work(hala, "general-dermatology", 1_000, 1);
    const d = await draft(hala, [w6.chargeId]);
    expect(d.total).toBe(800);
    // The desk takes 100 off: the contract's 20% is of the 900 left, put right on the draft at once.
    const discounted = await post(discountPost, `/api/invoices/${d.id}/discount`, d.id, { chargeId: w6.chargeId, amount: 100, reason: "LOYALTY" }, receptionCookie);
    expect(discounted.res.status, JSON.stringify(discounted.json)).toBe(200);
    expect(discounted.json.invoice.total).toBe(720);
    const issued = await issue(d.id);
    expect(issued).toMatchObject({ total: 720, claimed: 648, due: 72 });
    const line = await db.claimLine.findFirstOrThrow({ where: { tenantId: a, chargeId: w6.chargeId } });
    expect(line).toMatchObject({ amount: 720, contractDiscount: 180, patientShare: 72, payerShare: 648 });
    // The contract discount of 200 (of the 1,000) was reversed, never deleted.
    const contract = await db.charge.findMany({ where: { tenantId: a, discountOfId: w6.chargeId, reason: "CONTRACT" }, orderBy: { amount: "asc" }, select: { amount: true, reversedBy: { select: { amount: true } } } });
    expect(contract.map((c) => [c.amount, c.reversedBy?.amount ?? null])).toEqual([
      [-200, 200],
      [-180, null],
    ]);
  });
});
