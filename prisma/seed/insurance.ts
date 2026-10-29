import type { SeedContext } from "./index";
import { dateKeyInTz, fromDateKey } from "../../src/lib/time";
import { FinanceError } from "../../src/modules/finance/errors";
import { answerContext, recordPayerAnswer, sendClaims } from "../../src/modules/insurance/batches";
import { answerApproval, requestApproval } from "../../src/modules/insurance/covers";
import { contractDiscountOf, contractOn, contractYear, patientShareOf, ruleFor, within, type ContractTerms } from "../../src/modules/insurance/terms";

/**
 * Insurance and companies for the demo clinic.
 *
 * Before the money is seeded: three payers and their contracts (an insurer
 * since January, a network for company groups since last July that pays
 * late, a software house paying for its staff since March) and their
 * members' covers. The finance step then has those patients pay only their
 * share of covered work (`ctx.insurance`), and the invoices step makes the
 * claims for the rest as each invoice is issued.
 *
 * After the invoices: each payer's claims go in a batch on the 5th of the
 * next month; the insurer pays its batches in about five weeks (once a line
 * above the contract's price is refused back to the patient, once a line not
 * covered is written off), the company in three, and the network has not
 * paid since the summer. Approvals asked of the payers: one waiting, one
 * approved, one refused.
 */

const TZ = "Africa/Cairo";
const DAY = 86_400_000;

/** Payers, as the clinic knows them (made-up names; the e-mail domains are reserved for examples). */
const PAYERS = [
  {
    key: "nilecrest",
    name: "Nilecrest Health Insurance",
    kind: "INSURER" as const,
    contactName: "Claims desk",
    phone: "+20 2 2461 7300",
    email: "claims@nilecrest.example",
    paymentDays: 45,
    contract: { reference: "NC-PRV-2026-118", from: "01-01", yearsBack: 0, discountPct: 15, copayPct: 20, annualLimit: 20_000, approvalAbove: 3_000 },
    rules: [
      { category: "laser", covered: false },
      { category: "injectables", covered: false },
      { category: "hair", covered: false },
      { item: "CONS-HAIR", covered: true },
    ],
    members: 5,
    plans: ["Gold", "Silver", "Gold", "Silver", "Gold"],
  },
  {
    key: "saqqara",
    name: "Saqqara Care Network",
    kind: "INSURER" as const,
    contactName: "Provider relations",
    phone: "+20 2 3337 9050",
    email: "providers@saqqaracare.example",
    paymentDays: 60,
    contract: { reference: "SCN-447", from: "07-01", yearsBack: 1, discountPct: 10, copayPct: 10, annualLimit: null, approvalAbove: 4_000 },
    rules: [
      { category: "laser", covered: false },
      { category: "injectables", covered: false },
      { category: "hair", covered: false },
    ],
    members: 3,
    plans: ["Corporate A", "Corporate A", "Corporate B"],
    employer: "Corniche Logistics",
  },
  {
    key: "papyrus",
    name: "Papyrus Software House",
    kind: "COMPANY" as const,
    contactName: "HR benefits",
    phone: "+20 2 2525 1188",
    email: "benefits@papyrus-software.example",
    paymentDays: 30,
    contract: { reference: "Staff medical scheme 2026", from: "03-01", yearsBack: 0, discountPct: 0, copayPct: 0, annualLimit: 25_000, approvalAbove: null },
    rules: [
      { category: "laser", covered: false },
      { category: "injectables", covered: false },
      { category: "hair", covered: false },
    ],
    members: 2,
    plans: ["Staff", "Staff family"],
  },
] as const;

/** Patients whose work is general or skin (what the payers cover), not the named family of the family-account step. */
const NOT_COVERED_TAGS = new Set(["hair-transplant", "hair-loss", "laser"]);
const FAMILY = new Set(["Hany Nabil", "Nesma Hany", "Sherif Hany"]);

const keyAt = (now: Date, offsetDays: number) => dateKeyInTz(new Date(now.getTime() + offsetDays * DAY), TZ);
const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const nextDay = (key: string) => dateKeyInTz(new Date(fromDateKey(key, TZ)!.getTime() + 36 * 3_600_000), TZ);

export async function seedInsuranceCover(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const year = Number(keyAt(now, 0).slice(0, 4));
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const consHair = await db.priceItem.findFirst({ where: { tenantId, code: "CONS-HAIR" }, select: { id: true } });
  const candidates = ctx.patients.filter((p) => !NOT_COVERED_TAGS.has(p.tag) && !FAMILY.has(p.fullName)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const facts = new Map<string, { payerId: string; cover: { validFrom: string; validTo: string | null }; terms: ContractTerms[] }>();
  let next = 0;
  let covered = 0;
  for (const p of PAYERS) {
    const payer = await db.payer.create({
      data: { tenantId, name: p.name, kind: p.kind, contactName: p.contactName, phone: p.phone, email: p.email, paymentDays: p.paymentDays, createdById: owner.id },
      select: { id: true },
    });
    const validFrom = `${year - p.contract.yearsBack}-${p.contract.from}`;
    const contract = await db.payerContract.create({
      data: {
        tenantId,
        payerId: payer.id,
        reference: p.contract.reference,
        validFrom: asDate(validFrom),
        discountPct: p.contract.discountPct,
        copayPct: p.contract.copayPct,
        annualLimit: p.contract.annualLimit,
        approvalAbove: p.contract.approvalAbove,
        coveredByDefault: true,
        createdById: owner.id,
      },
      select: { id: true },
    });
    const rules: { tenantId: string; contractId: string; category: string | null; priceItemId: string | null; covered: boolean }[] = [];
    for (const r of p.rules) {
      if (!("item" in r)) rules.push({ tenantId, contractId: contract.id, category: r.category, priceItemId: null, covered: r.covered });
      else if (consHair) rules.push({ tenantId, contractId: contract.id, category: null, priceItemId: consHair.id, covered: r.covered });
    }
    await db.payerRule.createMany({ data: rules });
    const terms: ContractTerms = {
      id: contract.id,
      validFrom,
      validTo: null,
      discountPct: p.contract.discountPct,
      copayPct: p.contract.copayPct,
      annualLimit: p.contract.annualLimit,
      approvalAbove: p.contract.approvalAbove,
      coveredByDefault: true,
      rules: rules.map((r) => ({ category: r.category, priceItemId: r.priceItemId, covered: r.covered, copayPct: null, needsApproval: false })),
    };
    for (let i = 0; i < p.members && next < candidates.length; i++, next += 2) {
      const patient = candidates[next]!;
      await db.coverage.create({
        data: {
          tenantId,
          patientId: patient.id,
          payerId: payer.id,
          memberNumber: `${p.key === "nilecrest" ? "NC" : p.key === "saqqara" ? "SCN" : "PSH"}-${String(10_421 + next * 37).padStart(6, "0")}`,
          plan: p.plans[i] ?? null,
          employer: "employer" in p ? p.employer : null,
          relation: p.key === "papyrus" && i === 1 ? "SPOUSE" : "SELF",
          validFrom: asDate(validFrom),
          createdById: owner.id,
          createdAt: new Date(fromDateKey(validFrom, TZ)!.getTime() + 10 * 3_600_000),
        },
      });
      facts.set(patient.id, { payerId: payer.id, cover: { validFrom, validTo: null }, terms: [terms] });
      covered += 1;
    }
  }

  // What a covered patient pays of work at the desk: their share at the contract's price, the rest claimed at
  // the invoice (as modules/insurance/claims.ts works it out). The yearly limits are far above the demo's work.
  const used = new Map<string, number>();
  ctx.insurance = {
    patientShare(patientId, work) {
      const f = facts.get(patientId);
      if (!f || !within(f.cover, work.day)) return null;
      const terms = contractOn(f.terms, work.day);
      if (!terms) return null;
      const ruling = ruleFor(terms, { priceItemId: null, category: work.category });
      if (!ruling.covered) return null;
      const net = work.amount - contractDiscountOf(work.amount, terms.discountPct);
      if (ruling.needsApproval || (terms.approvalAbove !== null && net > terms.approvalAbove)) return null;
      let payer = net - patientShareOf(net, ruling.copayPct);
      if (terms.annualLimit !== null) {
        const key = `${patientId}:${contractYear(terms.validFrom, work.day).from}`;
        payer = Math.min(payer, Math.max(0, terms.annualLimit - (used.get(key) ?? 0)));
        used.set(key, (used.get(key) ?? 0) + payer);
        if (payer <= 0) return null;
      }
      return net - payer;
    },
  };
  console.log(`     insurance: ${PAYERS.length} payers with their contracts, ${covered} patients covered`);
}

/** The 5th of the month after a day's month, as a day key. */
const fifthAfter = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-05`;
};
const lastOfMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
};
const addDaysKey = (key: string, days: number) => new Date(asDate(key).getTime() + days * DAY).toISOString().slice(0, 10);

export async function seedClaims(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = ctx.today;
  const today = keyAt(now, 0);
  const at = (key: string, hour: number) => new Date(Math.min(now.getTime() - 60_000, fromDateKey(key, TZ)!.getTime() + hour * 3_600_000));
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? owner;
  const actor = (u: { id: string; email: string; role: SeedContext["users"][number]["role"] }) => ({ id: u.id, email: u.email, role: u.role });
  const payers = await db.payer.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const keyOf = new Map(payers.map((p) => [p.id, PAYERS.find((x) => x.name === p.name)?.key]));

  // Each month's claims go on the 5th of the next, every payer's in date order, so the batch numbers run with the days.
  const sends: { payerId: string; month: string; sentOn: string }[] = [];
  for (const payer of payers) {
    const first = await db.claim.findFirst({ where: { tenantId, payerId: payer.id }, orderBy: { claimedAt: "asc" }, select: { claimedAt: true } });
    if (!first) continue;
    for (let month = dateKeyInTz(first.claimedAt, TZ); fifthAfter(month) <= today; month = nextDay(lastOfMonth(month))) sends.push({ payerId: payer.id, month, sentOn: fifthAfter(month) });
  }
  sends.sort((a, b) => a.sentOn.localeCompare(b.sentOn));
  let batches = 0;
  for (const s of sends) {
    try {
      const made = await sendClaims(tenantId, { payerId: s.payerId, upTo: lastOfMonth(s.month), sentOn: s.sentOn }, actor(reception), { now: at(s.sentOn, 11) });
      batches += made.length;
    } catch (error) {
      // A month with no claim to send.
      if (!(error instanceof FinanceError && error.code === "nothing_to_send")) throw error;
    }
  }

  // The payers' answers, in the order the money came: the insurer in five weeks, the company in three, the network not since the summer.
  const sent = await db.claimBatch.findMany({ where: { tenantId }, orderBy: { sentAt: "asc" }, select: { id: true, number: true, payerId: true, sentAt: true } });
  const due = sent
    .map((b) => {
      const key = keyOf.get(b.payerId);
      const sentOn = dateKeyInTz(b.sentAt, TZ);
      return { ...b, key, sentOn, paidOn: addDaysKey(sentOn, key === "papyrus" ? 20 : key === "saqqara" ? 52 : 35) };
    })
    .filter((b) => b.paidOn <= today && !(b.key === "saqqara" && b.sentOn >= addDaysKey(today, -120)))
    .sort((a, b) => a.paidOn.localeCompare(b.paidOn));
  const answered = new Map<string, number>();
  let answers = 0;
  for (const b of due) {
    const lines = await answerContext(tenantId, b.payerId, { batchId: b.id });
    if (!lines.length) continue;
    const n = (answered.get(b.payerId) ?? 0) + 1;
    answered.set(b.payerId, n);
    const paid = lines.map((l, i) => {
      // The insurer's first answer refuses part of a line above its price (the patient's to pay); its second, a line it does not cover (written off).
      if (b.key === "nilecrest" && n === 1 && i === 0 && l.owed > 300) return { claimLineId: l.id, paid: l.owed - 300, refused: 300, reason: "PRICE" as const };
      if (b.key === "nilecrest" && n === 2 && i === 0) return { claimLineId: l.id, paid: 0, refused: l.owed, reason: "NOT_COVERED" as const, writeOff: true };
      return { claimLineId: l.id, paid: l.owed };
    });
    await recordPayerAnswer(
      tenantId,
      { payerId: b.payerId, batchId: b.id, paidOn: b.paidOn, method: b.key === "papyrus" ? "INSTAPAY" : "BANK_TRANSFER", reference: b.number.replace(/^.*-CB-/, "REM-"), lines: paid },
      actor(owner),
      { now: at(b.paidOn, 13) },
    );
    answers += 1;
  }

  // Approvals asked of the payers: one waiting, one approved, one refused.
  const covers = await db.coverage.findMany({ where: { tenantId }, orderBy: [{ validFrom: "asc" }, { memberNumber: "asc" }], select: { id: true, patientId: true, payer: { select: { name: true } } } });
  const nilecrest = covers.filter((c) => c.payer.name === "Nilecrest Health Insurance");
  const saqqara = covers.filter((c) => c.payer.name === "Saqqara Care Network");
  const planned = async (patientId: string) => db.procedure.findFirst({ where: { tenantId, patientId, status: "PLANNED", deletedAt: null }, select: { id: true } });
  let approvals = 0;
  if (nilecrest[0]) {
    const c = nilecrest[0];
    await requestApproval(tenantId, c.patientId, { coverageId: c.id, procedureId: (await planned(c.patientId))?.id, description: "Excision of a sebaceous cyst under local anaesthesia", amount: 4_500, requestedOn: keyAt(now, -3) }, actor(reception), { now: at(keyAt(now, -3), 12) });
    approvals += 1;
  }
  if (saqqara[0]) {
    const c = saqqara[0];
    const asked = keyAt(now, -12);
    const insurance = await requestApproval(tenantId, c.patientId, { coverageId: c.id, procedureId: (await planned(c.patientId))?.id, description: "Chemical peel course, three sessions", amount: 6_000, requestedOn: asked }, actor(reception), { now: at(asked, 12) });
    const a = insurance.approvals[0]!;
    await answerApproval(tenantId, a.id, { status: "APPROVED", approvalNumber: "SCN-APR-20931", approvedAmount: 5_400, validUntil: keyAt(now, 50), answeredOn: keyAt(now, -9) }, actor(reception), { now: at(keyAt(now, -9), 14) });
    approvals += 1;
  }
  if (nilecrest[1]) {
    const c = nilecrest[1];
    const asked = keyAt(now, -20);
    const insurance = await requestApproval(tenantId, c.patientId, { coverageId: c.id, description: "Fractional laser for acne scars, four sessions", amount: 9_600, requestedOn: asked }, actor(reception), { now: at(asked, 12) });
    const a = insurance.approvals[0]!;
    await answerApproval(tenantId, a.id, { status: "REFUSED", reason: "Cosmetic: not covered by the contract", answeredOn: keyAt(now, -16) }, actor(reception), { now: at(keyAt(now, -16), 15) });
    approvals += 1;
  }
  const open = await db.claim.count({ where: { tenantId, status: "OPEN" } });
  console.log(`     claims: ${await db.claim.count({ where: { tenantId } })} made, ${batches} batches sent, ${answers} answers recorded, ${open} still to send; ${approvals} approvals`);
}
