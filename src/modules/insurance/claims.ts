import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { postCharge } from "@/modules/finance/charges";
import { CONTRACT_DISCOUNT } from "@/modules/finance/constants";
import { takeNumber } from "@/modules/finance/documents";
import { FinanceError } from "@/modules/finance/errors";
import { DISCOUNT_WORDS } from "@/modules/finance/ledger-copy";
import { contractDiscountOf, contractOn, contractYear, ruleFor, shareLines, within, type ApprovalLeft, type ContractTerms, type ShareNote, type WorkLine } from "./terms";

/**
 * Claims: the payer's share of a covered patient's invoice. While the invoice
 * is a draft, the contract in force on each piece of work's day is applied
 * to it: covered work gets the contract's discount (a discount line on the
 * invoice, reason "contract price"), and is shared between the patient and
 * the payer (the co-pay), within the approval the work needs and what is
 * left of the member's yearly limit. Work the payer pays nothing of (no
 * approval, the limit used up) is the patient's at the clinic's price. When the invoice is issued, a claim is
 * made for each cover it touches, numbered in the branch's claim sequence;
 * it settles the payer's share of the invoice, and the patient pays the
 * rest. Cancelling the invoice cancels its claims while the payer has paid
 * nothing of them.
 *
 * These helpers run inside the caller's transaction.
 */

type Tx = Prisma.TransactionClient;
type Client = Tx | typeof db;

const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const dayAfter = (key: string) => keyOf(new Date(new Date(`${key}T00:00:00Z`).getTime() + 86_400_000));

// ── The facts ────────────────────────────────────────────────────────────────

interface CoverFacts {
  id: string;
  payerId: string;
  payerName: string;
  memberNumber: string;
  validFrom: string;
  validTo: string | null;
  contracts: ContractTerms[];
}

const contractSelect = {
  id: true,
  validFrom: true,
  validTo: true,
  discountPct: true,
  copayPct: true,
  annualLimit: true,
  approvalAbove: true,
  coveredByDefault: true,
  rules: { select: { category: true, priceItemId: true, covered: true, copayPct: true, needsApproval: true } },
} as const;

type ContractRow = Prisma.PayerContractGetPayload<{ select: typeof contractSelect }>;

export const toTerms = (c: ContractRow): ContractTerms => ({ ...c, validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null });

/** A patient's covers, with their payers' contracts. */
async function coversOf(client: Client, tenantId: string, patientId: string): Promise<CoverFacts[]> {
  const rows = await client.coverage.findMany({
    where: { tenantId, patientId },
    orderBy: [{ validFrom: "asc" }, { createdAt: "asc" }],
    select: { id: true, memberNumber: true, validFrom: true, validTo: true, payer: { select: { id: true, name: true, contracts: { select: contractSelect } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    payerId: r.payer.id,
    payerName: r.payer.name,
    memberNumber: r.memberNumber,
    validFrom: keyOf(r.validFrom),
    validTo: r.validTo ? keyOf(r.validTo) : null,
    contracts: r.payer.contracts.map(toTerms),
  }));
}

/** What a claim line takes of the payer: its share, less what the payer refused of it. */
const takenOf = (l: { payerShare: number; answers: { refused: number }[] }) => l.payerShare - l.answers.reduce((s, a) => s + a.refused, 0);

/** The patient's approved approvals, each with what claims have not taken of it yet. */
async function approvalsOf(client: Client, tenantId: string, patientId: string): Promise<(ApprovalLeft & { coverageId: string; number: string | null })[]> {
  const rows = await client.preApproval.findMany({
    where: { tenantId, patientId, status: "APPROVED" },
    orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      coverageId: true,
      procedureId: true,
      approvalNumber: true,
      approvedAmount: true,
      validUntil: true,
      claimLines: { where: { claim: { status: { not: "CANCELLED" } } }, select: { payerShare: true, answers: { where: { voidedAt: null }, select: { refused: true } } } },
    },
  });
  return rows.map((a) => ({
    id: a.id,
    coverageId: a.coverageId,
    number: a.approvalNumber,
    procedureId: a.procedureId,
    validUntil: a.validUntil ? keyOf(a.validUntil) : null,
    left: Math.max(0, (a.approvedAmount ?? 0) - a.claimLines.reduce((s, l) => s + takenOf(l), 0)),
  }));
}

/** What a payer's claims for a patient took of a contract year (its first and last day): their shares, less what was refused. */
export async function limitUsed(client: Client, tenantId: string, patientId: string, payerId: string, from: string, to: string, timezone: string): Promise<number> {
  const lines = await client.claimLine.findMany({
    where: {
      tenantId,
      claim: { patientId, payerId, status: { not: "CANCELLED" } },
      workedAt: { gte: fromDateKey(from, timezone)!, lt: fromDateKey(dayAfter(to), timezone)! },
    },
    select: { payerShare: true, answers: { where: { voidedAt: null }, select: { refused: true } } },
  });
  return lines.reduce((s, l) => s + takenOf(l), 0);
}

interface InvoiceWork {
  chargeId: string;
  patientId: string;
  procedureId: string | null;
  appointmentId: string | null;
  doctorId: string | null;
  clinicId: string | null;
  description: string;
  chargedAt: Date;
  day: string;
  /** The charge for the work. */
  amount: number;
  /** Its discounts given at the desk or on the procedure (positive), not reversed. */
  otherDiscounts: number;
  /** Its contract discounts, not reversed. */
  contractDiscounts: { id: string; amount: number; description: string }[];
  priceItemId: string | null;
  category: string | null;
}

/** The work an invoice bills: each charge for work done, with its discounts, the contract's apart. */
async function invoiceWork(client: Client, tenantId: string, invoiceId: string, timezone: string): Promise<InvoiceWork[]> {
  const lines = await client.invoiceLine.findMany({
    where: { tenantId, invoiceId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      charge: {
        select: {
          id: true,
          patientId: true,
          amount: true,
          description: true,
          chargedAt: true,
          procedureId: true,
          appointmentId: true,
          doctorId: true,
          clinicId: true,
          discountOfId: true,
          reversalOfId: true,
          reason: true,
          reversedBy: { select: { id: true } },
          procedure: { select: { priceItemId: true, priceItem: { select: { category: true } }, treatment: { select: { category: true } } } },
        },
      },
    },
  });
  const charges = lines.map((l) => l.charge);
  return charges
    .filter((c) => c.amount > 0 && !c.discountOfId && !c.reversalOfId && !c.reversedBy)
    .map((c) => {
      const discounts = charges.filter((d) => d.discountOfId === c.id && !d.reversedBy);
      return {
        chargeId: c.id,
        patientId: c.patientId,
        procedureId: c.procedureId,
        appointmentId: c.appointmentId,
        doctorId: c.doctorId,
        clinicId: c.clinicId,
        description: c.description,
        chargedAt: c.chargedAt,
        day: dateKeyInTz(c.chargedAt, timezone),
        amount: c.amount,
        otherDiscounts: -discounts.filter((d) => d.reason !== CONTRACT_DISCOUNT).reduce((s, d) => s + d.amount, 0),
        contractDiscounts: discounts.filter((d) => d.reason === CONTRACT_DISCOUNT).map((d) => ({ id: d.id, amount: -d.amount, description: d.description })),
        priceItemId: c.procedure?.priceItemId ?? null,
        category: c.procedure?.priceItem?.category ?? c.procedure?.treatment.category ?? null,
      };
    });
}

// ── The split ────────────────────────────────────────────────────────────────

/** Why the payer pays nothing or less for a line (the contract's own words besides). */
export type SplitNote = ShareNote | "no_cover" | "no_contract";

export interface SplitLine {
  chargeId: string;
  procedureId: string | null;
  description: string;
  /** When the work was done (ISO), and its day on the clinic clock. */
  chargedAt: string;
  day: string;
  /** The work after every discount on it, the contract's as the invoice will have it. */
  amount: number;
  /** The contract's discount on it (on the invoice, or put on it when the draft is issued). */
  contractDiscount: number;
  /** Not on the draft yet: put on it when it is issued. */
  contractDiscountToAdd: number;
  /** Contract discounts the work no longer takes (its cover ended): reversed when the draft is issued. */
  contractDiscountsToReverse: { id: string; amount: number; description: string }[];
  covered: boolean;
  coverageId: string | null;
  payerId: string | null;
  payerName: string | null;
  contractId: string | null;
  copayPct: number;
  needsApproval: boolean;
  approvalId: string | null;
  approvalNumber: string | null;
  patientShare: number;
  payerShare: number;
  note: SplitNote | null;
}

export interface SplitClaim {
  coverageId: string;
  payerId: string;
  payerName: string;
  memberNumber: string;
  /** What the payer is asked for, and what the patient pays of the same work. */
  amount: number;
  patientShare: number;
  lines: SplitLine[];
}

export interface InvoiceSplit {
  /** The patient has a cover on the day of some of the work. */
  insured: boolean;
  lines: SplitLine[];
  claims: SplitClaim[];
  /** The invoice's total once the contract's discounts are on it. */
  total: number;
  claimed: number;
  /** Everything not claimed: the patient's shares, the work no cover pays for, any other line. */
  patientPays: number;
}

/**
 * How an invoice's work is shared between the patient and their payers: the
 * cover on each piece of work's day and its payer's contract in force then;
 * the lines of one cover and contract shared together, in the invoice's order.
 */
export async function splitInvoice(client: Client, tenantId: string, invoiceId: string): Promise<InvoiceSplit> {
  const invoice = await client.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { patientId: true, total: true } });
  if (!invoice) throw new FinanceError(404, "not_found", `invoice ${invoiceId} not found`, { entity: "invoice" });
  const timezone = await getTenantTimezone(tenantId, client);
  const [work, covers] = await Promise.all([invoiceWork(client, tenantId, invoiceId, timezone), coversOf(client, tenantId, invoice.patientId)]);
  const base = (w: InvoiceWork, extra: Partial<SplitLine> = {}): SplitLine => ({
    chargeId: w.chargeId,
    procedureId: w.procedureId,
    description: w.description,
    chargedAt: w.chargedAt.toISOString(),
    day: w.day,
    amount: w.amount - w.otherDiscounts - w.contractDiscounts.reduce((s, d) => s + d.amount, 0),
    contractDiscount: w.contractDiscounts.reduce((s, d) => s + d.amount, 0),
    contractDiscountToAdd: 0,
    contractDiscountsToReverse: [],
    covered: false,
    coverageId: null,
    payerId: null,
    payerName: null,
    contractId: null,
    copayPct: 100,
    needsApproval: false,
    approvalId: null,
    approvalNumber: null,
    patientShare: 0,
    payerShare: 0,
    note: null,
    ...extra,
  });
  if (!covers.length) {
    const lines = work.map((w) => base(w, { note: "no_cover" })).map((l) => ({ ...l, patientShare: l.amount }));
    return { insured: false, lines, claims: [], total: invoice.total, claimed: 0, patientPays: invoice.total };
  }

  const approvals = await approvalsOf(client, tenantId, invoice.patientId);
  const used = new Map<string, number>();
  const usedKey = (payerId: string, year: string) => `${payerId}:${year}`;
  const split = new Map<string, SplitLine>();
  // The work of one cover under one contract, in the invoice's order.
  const groups = new Map<string, { cover: CoverFacts; terms: ContractTerms; work: InvoiceWork[] }>();
  for (const w of work) {
    const cover = covers.find((c) => within(c, w.day));
    if (!cover) {
      split.set(w.chargeId, base(w, { note: "no_cover", contractDiscountsToReverse: w.contractDiscounts }));
      continue;
    }
    const terms = contractOn(cover.contracts, w.day);
    if (!terms) {
      split.set(w.chargeId, base(w, { note: "no_contract", coverageId: cover.id, payerId: cover.payerId, payerName: cover.payerName, contractDiscountsToReverse: w.contractDiscounts }));
      continue;
    }
    const key = `${cover.id}:${terms.id}`;
    const group = groups.get(key) ?? { cover, terms, work: [] };
    group.work.push(w);
    groups.set(key, group);
  }

  for (const { cover, terms, work: lines } of groups.values()) {
    const workLines: WorkLine[] = [];
    const pending = new Map<string, Partial<SplitLine>>();
    for (const w of lines) {
      const ruling = ruleFor(terms, w);
      const posted = w.contractDiscounts.reduce((s, d) => s + d.amount, 0);
      const net = w.amount - w.otherDiscounts;
      // Covered work takes the contract's discount once; work it no longer covers gives it back.
      const discount = ruling.covered ? (posted || contractDiscountOf(net, terms.discountPct)) : 0;
      pending.set(w.chargeId, {
        contractDiscount: discount,
        contractDiscountToAdd: ruling.covered && !posted ? discount : 0,
        contractDiscountsToReverse: ruling.covered ? [] : w.contractDiscounts,
        amount: net - discount,
      });
      workLines.push({ chargeId: w.chargeId, day: w.day, amount: net - discount, priceItemId: w.priceItemId, category: w.category, procedureId: w.procedureId });
    }
    // What the payer's earlier claims took of each contract year these lines fall in.
    for (const year of new Set(workLines.map((l) => contractYear(terms.validFrom, l.day).from))) {
      if (terms.annualLimit === null || used.has(usedKey(cover.payerId, year))) continue;
      const span = contractYear(terms.validFrom, year);
      used.set(usedKey(cover.payerId, year), await limitUsed(client, tenantId, invoice.patientId, cover.payerId, span.from, span.to, timezone));
    }
    const ours = approvals.filter((a) => a.coverageId === cover.id);
    const shares = shareLines(terms, workLines, { approvals: ours, limitUsed: (year) => used.get(usedKey(cover.payerId, year)) ?? 0 });
    for (const s of shares) {
      const w = lines.find((l) => l.chargeId === s.chargeId)!;
      // What this invoice takes is gone for the next group of the same cover.
      if (s.approvalId) {
        const approval = ours.find((a) => a.id === s.approvalId);
        if (approval) approval.left -= s.payerShare;
      }
      if (terms.annualLimit !== null) {
        const year = usedKey(cover.payerId, contractYear(terms.validFrom, w.day).from);
        used.set(year, (used.get(year) ?? 0) + s.payerShare);
      }
      // Work the payer pays nothing of (no approval, the limit used up) is the patient's at the clinic's price.
      const unpaid = s.covered && s.payerShare === 0;
      split.set(
        s.chargeId,
        base(w, {
          ...pending.get(s.chargeId),
          ...(unpaid ? { contractDiscount: 0, contractDiscountToAdd: 0, contractDiscountsToReverse: w.contractDiscounts, amount: w.amount - w.otherDiscounts } : {}),
          covered: s.covered,
          coverageId: cover.id,
          payerId: cover.payerId,
          payerName: cover.payerName,
          contractId: terms.id,
          copayPct: s.copayPct,
          needsApproval: s.needsApproval,
          approvalId: s.approvalId,
          approvalNumber: s.approvalId ? (ours.find((a) => a.id === s.approvalId)?.number ?? null) : null,
          patientShare: unpaid ? w.amount - w.otherDiscounts : s.patientShare,
          payerShare: s.payerShare,
          note: s.note,
        }),
      );
    }
  }

  const ordered = work.map((w) => {
    const line = split.get(w.chargeId)!;
    return line.payerShare ? line : { ...line, patientShare: line.amount };
  });
  const adding = ordered.reduce((s, l) => s + l.contractDiscountToAdd, 0) - ordered.reduce((s, l) => s + l.contractDiscountsToReverse.reduce((t, d) => t + d.amount, 0), 0);
  const total = invoice.total - adding;
  // A claim never asks for more than the invoice bills (a reversed charge on it lowers what is billed).
  let over = ordered.reduce((s, l) => s + l.payerShare, 0) - Math.max(0, total);
  for (let i = ordered.length - 1; over > 0 && i >= 0; i--) {
    const line = ordered[i]!;
    const cut = Math.min(over, line.payerShare);
    if (!cut) continue;
    ordered[i] = { ...line, payerShare: line.payerShare - cut, patientShare: line.patientShare + cut, approvalId: line.payerShare - cut ? line.approvalId : null };
    over -= cut;
  }
  const claims: SplitClaim[] = [];
  for (const cover of covers) {
    const lines = ordered.filter((l) => l.coverageId === cover.id && l.payerShare > 0);
    if (!lines.length) continue;
    claims.push({
      coverageId: cover.id,
      payerId: cover.payerId,
      payerName: cover.payerName,
      memberNumber: cover.memberNumber,
      amount: lines.reduce((s, l) => s + l.payerShare, 0),
      patientShare: lines.reduce((s, l) => s + l.patientShare, 0),
      lines,
    });
  }
  const claimed = claims.reduce((s, c) => s + c.amount, 0);
  return { insured: ordered.some((l) => l.coverageId !== null), lines: ordered, claims, total, claimed, patientPays: total - claimed };
}

// ── The draft and the issue ──────────────────────────────────────────────────

/**
 * Put a draft's contract discounts on it: covered work's discount where it has
 * none yet, and the reversal of a contract discount on work its cover no
 * longer pays for. Returns the draft's new total.
 */
export async function applyContractDiscounts(tx: Tx, tenantId: string, invoiceId: string, actorId: string | null, now: Date): Promise<number> {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { status: true, total: true, patientId: true } });
  if (!invoice || invoice.status !== "DRAFT") return invoice?.total ?? 0;
  // A patient never covered has no contract to apply.
  if (!(await tx.coverage.count({ where: { tenantId, patientId: invoice.patientId } }))) return invoice.total;
  const split = await splitInvoice(tx, tenantId, invoiceId);
  const changes = split.lines.filter((l) => l.contractDiscountToAdd > 0 || l.contractDiscountsToReverse.length);
  if (!changes.length) return invoice.total;
  const timezone = await getTenantTimezone(tenantId, tx);
  const work = new Map((await invoiceWork(tx, tenantId, invoiceId, timezone)).map((w) => [w.chargeId, w]));
  let position = (await tx.invoiceLine.aggregate({ where: { tenantId, invoiceId }, _max: { position: true } }))._max.position ?? 0;
  for (const line of changes) {
    const w = work.get(line.chargeId)!;
    const posted = [];
    if (line.contractDiscountToAdd > 0) {
      posted.push(
        await postCharge(tx, {
          tenantId,
          patientId: w.patientId,
          procedureId: w.procedureId,
          appointmentId: w.appointmentId,
          amount: -line.contractDiscountToAdd,
          description: `Discount (${DISCOUNT_WORDS.en[CONTRACT_DISCOUNT]}, ${line.payerName}): ${w.description}`,
          chargedAt: now,
          doctorId: w.doctorId,
          clinicId: w.clinicId,
          createdById: actorId,
          discountOfId: w.chargeId,
          reason: CONTRACT_DISCOUNT,
        }),
      );
    }
    for (const d of line.contractDiscountsToReverse) {
      posted.push(
        await tx.charge.create({
          data: {
            tenantId,
            patientId: w.patientId,
            procedureId: w.procedureId,
            appointmentId: w.appointmentId,
            amount: d.amount,
            description: `Reversed: ${d.description}`.slice(0, 300),
            chargedAt: now,
            doctorId: w.doctorId,
            clinicId: w.clinicId,
            reversalOfId: d.id,
            createdById: actorId,
          },
        }),
      );
    }
    for (const c of posted) {
      position += 1;
      await tx.invoiceLine.create({ data: { tenantId, invoiceId, chargeId: c.id, description: c.description, amount: c.amount, chargedAt: c.chargedAt, position } });
    }
  }
  const total = (await tx.invoiceLine.aggregate({ where: { tenantId, invoiceId }, _sum: { amount: true } }))._sum.amount ?? 0;
  await tx.invoice.update({ where: { id: invoiceId }, data: { total } });
  return total;
}

export interface MadeClaim {
  id: string;
  number: string;
  payerName: string;
  amount: number;
}

/** Make the claims of an invoice just issued: one for each cover its work falls under, numbered in its branch's sequence. */
export async function claimInvoiceTx(tx: Tx, tenantId: string, invoiceId: string, actorId: string | null, now: Date): Promise<MadeClaim[]> {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { status: true, clinicId: true, patientId: true, number: true, issuedAt: true } });
  if (!invoice || invoice.status === "DRAFT" || invoice.status === "CANCELLED") return [];
  if (!(await tx.coverage.count({ where: { tenantId, patientId: invoice.patientId } }))) return [];
  const split = await splitInvoice(tx, tenantId, invoiceId);
  const made: MadeClaim[] = [];
  for (const c of split.claims) {
    const { sequence, number } = await takeNumber(tx, tenantId, invoice.clinicId, "CLAIM");
    const claim = await tx.claim.create({
      data: {
        tenantId,
        clinicId: invoice.clinicId,
        payerId: c.payerId,
        coverageId: c.coverageId,
        patientId: invoice.patientId,
        invoiceId,
        sequence,
        number,
        amount: c.amount,
        patientShare: c.patientShare,
        claimedAt: invoice.issuedAt ?? now,
        createdById: actorId,
        lines: {
          create: c.lines.map((l, i) => ({
            tenantId,
            chargeId: l.chargeId,
            procedureId: l.procedureId,
            contractId: l.contractId!,
            approvalId: l.approvalId,
            description: l.description,
            workedAt: new Date(l.chargedAt),
            amount: l.amount,
            contractDiscount: l.contractDiscount,
            patientShare: l.patientShare,
            payerShare: l.payerShare,
            position: i + 1,
          })),
        },
      },
      select: { id: true },
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: invoice.patientId,
        kind: "INSURANCE",
        title: `Claimed from ${c.payerName}: ${c.amount.toLocaleString("en-US")} EGP (${number})`,
        body: `Invoice ${invoice.number ?? ""} · the patient's share ${split.patientPays.toLocaleString("en-US")} EGP`,
        refId: claim.id,
        occurredAt: invoice.issuedAt ?? now,
      },
    });
    made.push({ id: claim.id, number, payerName: c.payerName, amount: c.amount });
  }
  return made;
}

/** Cancel an invoice's claims with it: refused once the payer has paid any of them. */
export async function cancelInvoiceClaimsTx(tx: Tx, tenantId: string, invoiceId: string, reason: string, now: Date): Promise<number> {
  const claims = await tx.claim.findMany({
    where: { tenantId, invoiceId, status: { not: "CANCELLED" } },
    select: { id: true, number: true, payer: { select: { name: true } }, lines: { select: { answers: { where: { voidedAt: null, paid: { gt: 0 } }, select: { id: true } } } } },
  });
  const paid = claims.find((c) => c.lines.some((l) => l.answers.length));
  if (paid) {
    throw new FinanceError(409, "claim_paid", "the payer has paid part of this invoice's claim", {
      message: `${paid.payer.name} has paid part of claim ${paid.number}: the invoice stays. Void that payment first if it was recorded by mistake.`,
    });
  }
  for (const c of claims) await tx.claim.update({ where: { id: c.id }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: `The invoice was cancelled: ${reason}`.slice(0, 300) } });
  return claims.length;
}
