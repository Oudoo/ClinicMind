import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { TenantScopeError } from "@/lib/tenant-scope";
import { addDays, dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import type { NextAppointmentDTO } from "@/modules/appointments/dto";
import { claimedOn, claimsSettling, CREDITING_KINDS, OPEN_INVOICE_STATUSES, patientCredit } from "./allocations";
import type { LedgerEntry, LedgerKind } from "./ledger-copy";

/**
 * The patient's account: every charge (work done, a reversal, a visit charged
 * nothing, a discount), every payment, deposit and consultation fee, every
 * refund, every write-off and what a family member paid for the patient (or
 * the patient for one), in date order with the balance after each line.
 * Positive is owed, negative is credit. Voided payments and write-offs voided
 * with their invoice are left out: they never counted.
 *
 *   balance = charges − deposits and payments + refunds − write-offs
 *             + paid for family members − paid by family members
 *             − claimed from insurers and companies + what they refused
 *
 * A consultation fee is charged and paid at once, so it shows on both sides.
 * A claim takes the payer's share off when its invoice is issued; what the
 * payer refuses comes back on the day of its answer (a cancelled claim never
 * counted). The same balance is also what is still due on open invoices,
 * plus what is not invoiced yet, minus the credit not yet put towards an
 * invoice.
 *
 * A family statement (the head and the members) leaves out what moved
 * between them: it shows the money that came in once, against every
 * member's charges.
 */

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;

/** Invoices whose lines are billed (a draft bills nothing yet; a cancelled one, nothing any more). */
const BILLED = ["ISSUED", "PART_PAID", "PAID"] as const;

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zFlag = z.preprocess((v) => v === "1" || v === "true" || v === true, z.boolean());

export const LedgerQuery = z
  .object({
    from: zDateKey.optional(),
    to: zDateKey.optional(),
    /** The whole family's account (the head's and the members'), when the patient is in one. */
    family: zFlag.default(false),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { path: ["to"], message: "The end is before the start" });
export type LedgerQuery = z.infer<typeof LedgerQuery>;

interface Subject {
  id: string;
  fullName: string;
}

type RawEntry = Omit<LedgerEntry, "balance"> & { createdAt: Date };

interface Transfer {
  id: string;
  amount: number;
  at: Date;
  payerId: string;
  payerName: string;
  receiptNumber: string | null;
  payeeId: string;
  payeeName: string;
  invoiceNumber: string | null;
}

/**
 * Money one patient's payments put towards another patient's invoices (the
 * head of a family paying for a member), dated when it could first pay it:
 * the later of the payment and the invoice.
 */
async function transfersOf(client: Client, tenantId: string, ids: string[]): Promise<Transfer[]> {
  if (!ids.length) return [];
  return client.$queryRaw<Transfer[]>`
    SELECT a.id, a.amount, GREATEST(p."paidAt", COALESCE(i."issuedAt", a."createdAt")) AS "at",
           p."patientId" AS "payerId", payer."fullName" AS "payerName", p."receiptNumber",
           i."patientId" AS "payeeId", payee."fullName" AS "payeeName", i.number AS "invoiceNumber"
    FROM "payment_allocations" a
    JOIN "payments" p ON p.id = a."paymentId"
    JOIN "invoices" i ON i.id = a."invoiceId"
    JOIN "patients" payer ON payer.id = p."patientId"
    JOIN "patients" payee ON payee.id = i."patientId"
    WHERE a."tenantId" = ${tenantId} AND p."deletedAt" IS NULL AND p."patientId" <> i."patientId"
      AND (p."patientId" = ANY(${ids}) OR i."patientId" = ANY(${ids}))`;
}

/** Claims not cancelled, of the patients given: what each asked of its payer, and what the payer refused when. */
async function claimsOf(client: Client, tenantId: string, ids: string[]) {
  return client.claim.findMany({
    where: { tenantId, patientId: { in: ids }, status: { not: "CANCELLED" } },
    select: {
      id: true,
      patientId: true,
      number: true,
      amount: true,
      claimedAt: true,
      createdAt: true,
      payer: { select: { name: true } },
      invoice: { select: { number: true } },
      lines: { select: { answers: { where: { voidedAt: null, refused: { gt: 0 } }, select: { id: true, refused: true, refusalReason: true, createdAt: true, payerPayment: { select: { paidAt: true } } } } } },
    },
  });
}

async function loadEntries(client: Client, tenantId: string, subjects: Subject[]): Promise<RawEntry[]> {
  const ids = subjects.map((s) => s.id);
  const name = new Map(subjects.map((s) => [s.id, s.fullName]));
  const [charges, payments, transfers, writeOffs, claims] = await Promise.all([
    client.charge.findMany({
      where: { tenantId, patientId: { in: ids } },
      select: {
        id: true,
        patientId: true,
        amount: true,
        description: true,
        chargedAt: true,
        createdAt: true,
        reversalOfId: true,
        discountOfId: true,
        reason: true,
        invoiceLines: { where: { invoice: { status: { in: [...BILLED] } } }, select: { invoice: { select: { number: true } } }, take: 1 },
      },
    }),
    client.payment.findMany({
      where: { tenantId, patientId: { in: ids }, deletedAt: null },
      select: {
        id: true,
        patientId: true,
        kind: true,
        method: true,
        amount: true,
        paidAt: true,
        createdAt: true,
        receiptNumber: true,
        note: true,
        procedure: { select: { treatment: { select: { name: true } } } },
      },
    }),
    transfersOf(client, tenantId, ids),
    client.writeOff.findMany({
      where: { tenantId, patientId: { in: ids }, voidedAt: null },
      select: { id: true, patientId: true, amount: true, reason: true, note: true, writtenOffAt: true, createdAt: true, invoice: { select: { number: true } } },
    }),
    claimsOf(client, tenantId, ids),
  ]);
  const blank = { description: null, method: null, towards: null, note: null, reason: null, counterpart: null, invoiceNumber: null } as const;
  const entries: RawEntry[] = [];
  for (const c of charges) {
    const kind: LedgerKind = c.reversalOfId ? "REVERSAL" : c.discountOfId ? "DISCOUNT" : c.amount > 0 ? "CHARGE" : c.amount < 0 ? "REVERSAL" : "NO_CHARGE";
    const invoice = c.invoiceLines[0]?.invoice.number ?? null;
    entries.push({
      ...blank,
      id: `charge:${c.id}`,
      at: c.chargedAt.toISOString(),
      createdAt: c.createdAt,
      kind,
      patientId: c.patientId,
      patientName: name.get(c.patientId) ?? "",
      reference: invoice,
      invoiceNumber: invoice,
      description: c.description,
      reason: c.reason,
      debit: Math.max(0, c.amount),
      credit: Math.max(0, -c.amount),
    });
  }
  for (const w of writeOffs) {
    entries.push({
      ...blank,
      id: `write-off:${w.id}`,
      at: w.writtenOffAt.toISOString(),
      createdAt: w.createdAt,
      kind: "WRITE_OFF",
      patientId: w.patientId,
      patientName: name.get(w.patientId) ?? "",
      reference: w.invoice.number,
      invoiceNumber: w.invoice.number,
      reason: w.reason,
      note: w.note,
      debit: 0,
      credit: w.amount,
    });
  }
  for (const c of claims) {
    const common = { ...blank, patientId: c.patientId, patientName: name.get(c.patientId) ?? "", reference: c.number, invoiceNumber: c.invoice.number, counterpart: c.payer.name };
    entries.push({ ...common, id: `claim:${c.id}`, at: c.claimedAt.toISOString(), createdAt: c.createdAt, kind: "CLAIMED", debit: 0, credit: c.amount });
    for (const a of c.lines.flatMap((l) => l.answers)) {
      entries.push({ ...common, id: `refused:${a.id}`, at: a.payerPayment.paidAt.toISOString(), createdAt: a.createdAt, kind: "REFUSED", reason: a.refusalReason, debit: a.refused, credit: 0 });
    }
  }
  for (const p of payments) {
    const amount = p.amount;
    entries.push({
      ...blank,
      id: `payment:${p.id}`,
      at: p.paidAt.toISOString(),
      createdAt: p.createdAt,
      kind: p.kind,
      patientId: p.patientId,
      patientName: name.get(p.patientId) ?? "",
      reference: p.receiptNumber,
      method: p.method,
      towards: p.procedure?.treatment.name ?? null,
      note: p.kind === "REFUND" ? p.note : null,
      // A refund is money going back out; a consultation fee is charged and paid at once.
      debit: p.kind === "REFUND" || p.kind === "CONSULTATION_FEE" ? amount : 0,
      credit: p.kind === "REFUND" ? 0 : amount,
    });
  }
  const inScope = new Set(ids);
  for (const t of transfers) {
    const payerIn = inScope.has(t.payerId);
    const payeeIn = inScope.has(t.payeeId);
    if (payerIn && payeeIn) continue; // within the family on one statement: the money is shown once, as it came in
    entries.push({
      ...blank,
      id: `transfer:${t.id}`,
      at: t.at.toISOString(),
      createdAt: t.at,
      kind: payerIn ? "PAID_FOR" : "PAID_BY",
      patientId: payerIn ? t.payerId : t.payeeId,
      patientName: payerIn ? t.payerName : t.payeeName,
      reference: t.receiptNumber,
      invoiceNumber: t.invoiceNumber,
      counterpart: payerIn ? t.payeeName : t.payerName,
      debit: payerIn ? t.amount : 0,
      credit: payerIn ? 0 : t.amount,
    });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

export interface AccountPosition {
  /** Owed now (negative: credit). */
  balance: number;
  /** Charges and consultation fees. */
  billed: number;
  /** Paid towards them (and written off): billed − balance − claimed. */
  received: number;
  /** Asked of insurers and companies (their claims, less what they refused). */
  claimed: number;
  dueOnInvoices: number;
  /** Charges on no issued invoice yet (a draft bills nothing yet). */
  notInvoiced: number;
  /** Paid and not yet put towards an invoice. */
  credit: number;
  openInvoices: { id: string; number: string | null; patientId: string; patientName: string; issuedAt: string | null; total: number; paid: number; writtenOff: number; claimed: number; due: number }[];
}

/** Each patient's balance now, or as it stood just before `asOf` (patients with nothing on their account are 0). */
export async function patientBalances(client: Client, tenantId: string, ids: readonly string[], asOf?: Date): Promise<Map<string, number>> {
  const unique = [...new Set(ids)];
  const balances = new Map(unique.map((id) => [id, 0]));
  if (!unique.length) return balances;
  const add = (id: string, amount: number) => balances.set(id, (balances.get(id) ?? 0) + amount);
  const before = asOf ? { lt: asOf } : undefined;
  const [charges, payments, transfers, writeOffs, claims] = await Promise.all([
    client.charge.groupBy({ by: ["patientId"], where: { tenantId, patientId: { in: unique }, ...(before ? { chargedAt: before } : {}) }, _sum: { amount: true } }),
    client.payment.groupBy({
      by: ["patientId", "kind"],
      where: { tenantId, patientId: { in: unique }, deletedAt: null, kind: { in: [...CREDITING_KINDS, "REFUND"] }, ...(before ? { paidAt: before } : {}) },
      _sum: { amount: true },
    }),
    transfersOf(client, tenantId, unique),
    client.writeOff.groupBy({ by: ["patientId"], where: { tenantId, patientId: { in: unique }, voidedAt: null, ...(before ? { writtenOffAt: before } : {}) }, _sum: { amount: true } }),
    claimsOf(client, tenantId, unique),
  ]);
  for (const c of charges) add(c.patientId, c._sum.amount ?? 0);
  for (const c of claims) {
    if (!asOf || c.claimedAt.getTime() < asOf.getTime()) add(c.patientId, -c.amount);
    for (const a of c.lines.flatMap((l) => l.answers)) if (!asOf || a.payerPayment.paidAt.getTime() < asOf.getTime()) add(c.patientId, a.refused);
  }
  for (const w of writeOffs) add(w.patientId, -(w._sum.amount ?? 0));
  for (const p of payments) add(p.patientId, p.kind === "REFUND" ? (p._sum.amount ?? 0) : -(p._sum.amount ?? 0));
  for (const t of transfers) {
    if (asOf && new Date(t.at).getTime() >= asOf.getTime()) continue;
    if (balances.has(t.payerId)) add(t.payerId, t.amount);
    if (balances.has(t.payeeId)) add(t.payeeId, -t.amount);
  }
  return balances;
}

/** Patients' balances are for the roles that take payments and the owner (as invoices are). */
export const canSeeAccounts = (role: UserRole) => can(role, "payments:write") || can(role, "finance:read");

/** Each row's patient balance, for a role that sees accounts (the rows as they are otherwise). */
export async function withPatientBalances<T extends { patientId: string }>(tenantId: string, role: UserRole, rows: T[]): Promise<T[]> {
  if (!rows.length || !canSeeAccounts(role)) return rows;
  const balances = await patientBalances(db, tenantId, rows.map((r) => r.patientId));
  return rows.map((r) => ({ ...r, patientBalance: balances.get(r.patientId) ?? 0 }));
}

/** The next appointment and the queue, each with its patient's balance (for a role that sees accounts). */
export async function nextWithBalances(tenantId: string, role: UserRole, next: NextAppointmentDTO): Promise<NextAppointmentDTO> {
  if (!canSeeAccounts(role)) return next;
  const [withBalance, ...queue] = await withPatientBalances(tenantId, role, [...(next.appointment ? [next.appointment] : []), ...next.queue]);
  return next.appointment ? { ...next, appointment: withBalance!, queue } : { ...next, queue: withBalance ? [withBalance, ...queue] : [] };
}

/** Where the account stands now, for one patient or a family. */
export async function accountPosition(tx: Tx, tenantId: string, subjects: Subject[]): Promise<AccountPosition> {
  const ids = subjects.map((s) => s.id);
  const name = new Map(subjects.map((s) => [s.id, s.fullName]));
  const [balances, charged, fees, notInvoiced, invoices, credits, claims] = await Promise.all([
    patientBalances(tx, tenantId, ids),
    tx.charge.aggregate({ where: { tenantId, patientId: { in: ids } }, _sum: { amount: true } }),
    tx.payment.aggregate({ where: { tenantId, patientId: { in: ids }, deletedAt: null, kind: "CONSULTATION_FEE" }, _sum: { amount: true } }),
    tx.charge.aggregate({ where: { tenantId, patientId: { in: ids }, invoiceLines: { none: { invoice: { status: { in: [...BILLED] } } } } }, _sum: { amount: true } }),
    tx.invoice.findMany({
      where: { tenantId, patientId: { in: ids }, status: { in: [...OPEN_INVOICE_STATUSES] } },
      orderBy: [{ issuedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        number: true,
        patientId: true,
        issuedAt: true,
        total: true,
        allocations: { select: { amount: true } },
        writeOffs: { where: { voidedAt: null }, select: { amount: true } },
        claims: claimsSettling,
      },
    }),
    Promise.all(ids.map((id) => patientCredit(tx, tenantId, id))),
    claimsOf(tx, tenantId, ids),
  ]);
  const balance = [...balances.values()].reduce((s, b) => s + b, 0);
  const billed = (charged._sum.amount ?? 0) + (fees._sum.amount ?? 0);
  const claimed = claims.reduce((s, c) => s + c.amount - c.lines.reduce((t, l) => t + l.answers.reduce((u, a) => u + a.refused, 0), 0), 0);
  const openInvoices = invoices.map((i) => {
    const paid = i.allocations.reduce((s, a) => s + a.amount, 0);
    const writtenOff = i.writeOffs.reduce((s, w) => s + w.amount, 0);
    const claimed = claimedOn(i.claims);
    return { id: i.id, number: i.number, patientId: i.patientId, patientName: name.get(i.patientId) ?? "", issuedAt: i.issuedAt?.toISOString() ?? null, total: i.total, paid, writtenOff, claimed, due: Math.max(0, i.total - paid - writtenOff - claimed) };
  });
  return {
    balance,
    billed,
    received: billed - balance - claimed,
    claimed,
    dueOnInvoices: openInvoices.reduce((s, i) => s + i.due, 0),
    notInvoiced: notInvoiced._sum.amount ?? 0,
    credit: credits.reduce((s, c) => s + c.credit, 0),
    openInvoices,
  };
}

export interface LedgerView {
  patient: Subject & { phone: string | null; language: string; householdHeadId: string | null };
  scope: "patient" | "family";
  /** The family shown (the head first), when the statement is the family's. */
  family: { headId: string; members: (Subject & { relation: string | null; head: boolean })[] } | null;
  timezone: string;
  /** The period, as days on the clinic clock (to is included); null: from the first line, or up to today. */
  from: string | null;
  to: string | null;
  /** Owed before the first day of the period. */
  opening: number;
  entries: LedgerEntry[];
  /** Owed at the end of the period. */
  closing: number;
  totals: { debit: number; credit: number };
  position: AccountPosition;
}

/**
 * The account for a period (every line when no dates are given): the balance
 * brought forward, the lines with the running balance, the balance carried
 * at the end, and where the account stands now.
 */
export async function getLedger(tenantId: string, patientId: string, rawQuery: unknown = {}): Promise<LedgerView> {
  const query = LedgerQuery.parse(rawQuery);
  const timezone = await getTenantTimezone(tenantId);
  const patient = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, fullName: true, phone: true, whatsapp: true, language: true, householdHeadId: true } });
  if (!patient) throw new TenantScopeError("patient", patientId);

  let subjects: Subject[] = [{ id: patient.id, fullName: patient.fullName }];
  let family: LedgerView["family"] = null;
  if (query.family) {
    const headId = patient.householdHeadId ?? patient.id;
    const people = await db.patient.findMany({
      where: { tenantId, OR: [{ id: headId }, { householdHeadId: headId }] },
      select: { id: true, fullName: true, householdHeadId: true, householdRelation: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    if (people.length > 1) {
      const ordered = [...people.filter((p) => p.id === headId), ...people.filter((p) => p.id !== headId)];
      subjects = ordered.map((p) => ({ id: p.id, fullName: p.fullName }));
      family = { headId, members: ordered.map((p) => ({ id: p.id, fullName: p.fullName, relation: p.householdRelation, head: p.id === headId })) };
    }
  }

  // Days on the clinic clock: from the start of the first to the end of the last.
  const start = query.from ? fromDateKey(query.from, timezone) : null;
  const lastDay = query.to ? fromDateKey(query.to, timezone) : null;
  if ((query.from && !start) || (query.to && !lastDay)) throw new z.ZodError([{ code: "custom", path: [query.from && !start ? "from" : "to"], message: "Not a real date" }]);
  const end = lastDay ? fromDateKey(dateKeyInTz(addDays(lastDay, 1, timezone), timezone), timezone) : null;

  const { raw, position } = await db.$transaction(async (tx) => ({
    raw: await loadEntries(tx, tenantId, subjects),
    position: await accountPosition(tx, tenantId, subjects),
  }));

  let running = 0;
  let opening = 0;
  const entries: LedgerEntry[] = [];
  for (const { createdAt: _createdAt, ...e } of raw) {
    running += e.debit - e.credit;
    const at = new Date(e.at);
    if (start && at < start) {
      opening = running;
      continue;
    }
    if (end && at >= end) continue;
    entries.push({ ...e, balance: running });
  }
  const totals = entries.reduce((t, e) => ({ debit: t.debit + e.debit, credit: t.credit + e.credit }), { debit: 0, credit: 0 });
  return {
    patient: { id: patient.id, fullName: patient.fullName, phone: patient.whatsapp ?? patient.phone, language: patient.language, householdHeadId: patient.householdHeadId },
    scope: family ? "family" : "patient",
    family,
    timezone,
    from: query.from ?? null,
    to: query.to ?? null,
    opening,
    entries,
    closing: opening + totals.debit - totals.credit,
    totals,
    position,
  };
}
