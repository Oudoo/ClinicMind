import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { allocateFor, refreshInvoiceStatus, settledOn } from "@/modules/finance/allocations";
import { METHOD_LABELS, PAYMENT_METHODS } from "@/modules/finance/constants";
import { takeNumber } from "@/modules/finance/documents";
import { FinanceError } from "@/modules/finance/errors";
import { toCsv } from "@/modules/reporting/csv";
import { CLAIM_STATUS_LABELS, COVER_RELATION_LABELS, REFUSAL_REASON_LABELS, REFUSAL_REASONS, type ClaimStatusValue, type CoverRelationValue, type RefusalReasonValue } from "./constants";
import type { InsuranceActor } from "./payers";

/**
 * Claims on their way to the payer and back.
 *
 * Claims not sent yet go to the payer in a batch: one for each branch, numbered
 * in the branch's batch sequence, with the day it went (usually a month's
 * claims, early the next month). A batch is fixed once sent, and its claims
 * stay in it.
 *
 * The payer's answer comes as money (a transfer, a cheque) and a list of what
 * it paid and refused of each claim line. The owner records it as it is: what
 * is refused is owed by the patient again, unless the owner writes it off
 * (a write-off on the patient's invoice, reason "refused by the insurer"). A
 * claim with every line paid or refused is answered. The owner voids an
 * answer recorded by mistake, with the reason: its write-offs go with it.
 */

type Tx = Prisma.TransactionClient;

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zId = zText(64).min(1);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

/** A moment for a day on the clinic clock: now for today, else noon that day. */
const momentOf = (key: string, timezone: string, now: Date) => (key === dateKeyInTz(now, timezone) ? now : new Date(fromDateKey(key, timezone)!.getTime() + 12 * 3_600_000));

export const CLAIM_VIEWS = ["open", "sent", "settled", "cancelled", "all"] as const;
export type ClaimView = (typeof CLAIM_VIEWS)[number];

export const ClaimListQuery = z.object({
  view: z.enum(CLAIM_VIEWS).default("open"),
  payerId: zOptionalText(64),
  q: zOptionalText(80),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const answersOf = { where: { voidedAt: null }, select: { paid: true, refused: true } } as const;
const sumAnswers = (lines: { payerShare: number; answers: { paid: number; refused: number }[] }[]) => {
  const paid = lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.paid, 0), 0);
  const refused = lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.refused, 0), 0);
  return { paid, refused, owed: lines.reduce((s, l) => s + l.payerShare, 0) - paid - refused };
};

const claimRowSelect = {
  id: true,
  number: true,
  status: true,
  claimedAt: true,
  amount: true,
  patientShare: true,
  clinicId: true,
  invoiceId: true,
  invoice: { select: { number: true } },
  patient: { select: { id: true, fullName: true } },
  payer: { select: { id: true, name: true, paymentDays: true } },
  coverage: { select: { memberNumber: true, plan: true, relation: true } },
  batch: { select: { id: true, number: true, sentAt: true } },
  lines: { select: { payerShare: true, answers: answersOf } },
} satisfies Prisma.ClaimSelect;
type ClaimRowData = Prisma.ClaimGetPayload<{ select: typeof claimRowSelect }>;

export interface ClaimRow {
  id: string;
  number: string;
  status: ClaimStatusValue;
  statusLabel: string;
  payerId: string;
  payerName: string;
  patientId: string;
  patientName: string;
  memberNumber: string;
  invoiceId: string;
  invoiceNumber: string | null;
  claimedAt: string;
  amount: number;
  patientShare: number;
  paid: number;
  refused: number;
  owed: number;
  batch: { id: string; number: string; sentAt: string } | null;
  /** Sent longer ago than the payer's days to pay, and still owed. */
  overdue: boolean;
}

function claimRow(c: ClaimRowData, now: Date): ClaimRow {
  const sums = sumAnswers(c.lines);
  const owed = c.status === "CANCELLED" ? 0 : sums.owed;
  return {
    id: c.id,
    number: c.number,
    status: c.status,
    statusLabel: c.status === "SETTLED" && sums.refused && !sums.paid ? "Refused" : c.status === "SENT" && sums.paid ? "Part paid" : CLAIM_STATUS_LABELS[c.status],
    payerId: c.payer.id,
    payerName: c.payer.name,
    patientId: c.patient.id,
    patientName: c.patient.fullName,
    memberNumber: c.coverage.memberNumber,
    invoiceId: c.invoiceId,
    invoiceNumber: c.invoice.number,
    claimedAt: c.claimedAt.toISOString(),
    amount: c.amount,
    patientShare: c.patientShare,
    paid: sums.paid,
    refused: sums.refused,
    owed,
    batch: c.batch ? { id: c.batch.id, number: c.batch.number, sentAt: c.batch.sentAt.toISOString() } : null,
    overdue: owed > 0 && c.batch !== null && now.getTime() - c.batch.sentAt.getTime() > c.payer.paymentDays * DAY,
  };
}

const VIEW_WHERE: Record<ClaimView, Prisma.ClaimWhereInput> = {
  open: { status: "OPEN" },
  sent: { status: "SENT" },
  settled: { status: "SETTLED" },
  cancelled: { status: "CANCELLED" },
  all: {},
};

export async function listClaims(tenantId: string, rawQuery: unknown = {}, now: Date = new Date()) {
  const query = ClaimListQuery.parse(rawQuery);
  const where: Prisma.ClaimWhereInput = {
    tenantId,
    ...VIEW_WHERE[query.view],
    ...(query.payerId ? { payerId: query.payerId } : {}),
    ...(query.q
      ? {
          OR: [
            { number: { contains: query.q, mode: "insensitive" } },
            { patient: { fullName: { contains: query.q, mode: "insensitive" } } },
            { coverage: { memberNumber: { contains: query.q, mode: "insensitive" } } },
            { invoice: { number: { contains: query.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [rows, total, all] = await Promise.all([
    db.claim.findMany({ where, orderBy: [{ claimedAt: query.view === "open" ? "asc" : "desc" }, { sequence: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: claimRowSelect }),
    db.claim.count({ where }),
    db.claim.findMany({ where, select: { status: true, amount: true, lines: { select: { payerShare: true, answers: answersOf } } } }),
  ]);
  return {
    rows: rows.map((r) => claimRow(r, now)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    totals: { amount: all.reduce((s, c) => s + c.amount, 0), owed: all.reduce((s, c) => s + (c.status === "CANCELLED" ? 0 : sumAnswers(c.lines).owed), 0) },
  };
}

export interface ClaimLineDTO {
  id: string;
  description: string;
  workedAt: string;
  amount: number;
  contractDiscount: number;
  patientShare: number;
  payerShare: number;
  approvalNumber: string | null;
  paid: number;
  refused: number;
  owed: number;
  answers: { id: string; paid: number; refused: number; reason: string | null; reasonLabel: string | null; paidAt: string; paymentId: string; reference: string | null; writtenOff: boolean }[];
}

export interface ClaimDetail extends ClaimRow {
  plan: string | null;
  relationLabel: string;
  cancelReason: string | null;
  lines: ClaimLineDTO[];
}

export async function getClaim(tenantId: string, id: string, now: Date = new Date()): Promise<ClaimDetail> {
  const c = await db.claim.findFirst({
    where: { id, tenantId },
    select: {
      ...claimRowSelect,
      cancelReason: true,
      lines: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          description: true,
          workedAt: true,
          amount: true,
          contractDiscount: true,
          patientShare: true,
          payerShare: true,
          approval: { select: { approvalNumber: true } },
          answers: {
            where: { voidedAt: null },
            orderBy: { createdAt: "asc" },
            select: { id: true, paid: true, refused: true, refusalReason: true, writeOffId: true, payerPayment: { select: { id: true, paidAt: true, reference: true } } },
          },
        },
      },
    },
  });
  if (!c) throw new TenantScopeError("claim", id);
  return {
    ...claimRow(c, now),
    plan: c.coverage.plan,
    relationLabel: COVER_RELATION_LABELS[c.coverage.relation as CoverRelationValue] ?? c.coverage.relation,
    cancelReason: c.cancelReason,
    lines: c.lines.map((l) => {
      const paid = l.answers.reduce((s, a) => s + a.paid, 0);
      const refused = l.answers.reduce((s, a) => s + a.refused, 0);
      return {
        id: l.id,
        description: l.description,
        workedAt: l.workedAt.toISOString(),
        amount: l.amount,
        contractDiscount: l.contractDiscount,
        patientShare: l.patientShare,
        payerShare: l.payerShare,
        approvalNumber: l.approval?.approvalNumber ?? null,
        paid,
        refused,
        owed: c.status === "CANCELLED" ? 0 : l.payerShare - paid - refused,
        answers: l.answers.map((a) => ({
          id: a.id,
          paid: a.paid,
          refused: a.refused,
          reason: a.refusalReason,
          reasonLabel: a.refusalReason ? (REFUSAL_REASON_LABELS[a.refusalReason as RefusalReasonValue] ?? a.refusalReason) : null,
          paidAt: a.payerPayment.paidAt.toISOString(),
          paymentId: a.payerPayment.id,
          reference: a.payerPayment.reference,
          writtenOff: Boolean(a.writeOffId),
        })),
      };
    }),
  };
}

// ── Sending ──────────────────────────────────────────────────────────────────

export const SendInput = z.object({
  payerId: zId,
  /** One branch's claims; all branches' when left out (a batch each). */
  clinicId: zOptionalText(64),
  /** These claims; else every claim not sent of work invoiced up to `upTo` (or all of them). */
  claimIds: z.array(zId).max(1000).optional(),
  upTo: zDayKey.optional(),
  /** The day they went (today when left out). */
  sentOn: zDayKey.optional(),
  reference: zOptionalText(120),
  note: zOptionalText(500),
});

export interface BatchSummary {
  id: string;
  number: string;
  claims: number;
  amount: number;
}

/** Send a payer's claims not sent yet: a numbered batch for each branch. */
export async function sendClaims(tenantId: string, rawInput: unknown, actor: InsuranceActor = {}, opts: { now?: Date } = {}): Promise<BatchSummary[]> {
  const input = SendInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(now, timezone);
  if (input.sentOn && input.sentOn > today) throw new z.ZodError([{ code: "custom", path: ["sentOn"], message: "Not a day ahead" }]);
  const sentAt = momentOf(input.sentOn ?? today, timezone, now);
  const batches = await db.$transaction(async (tx) => {
    const payer = await tx.payer.findFirst({ where: { id: input.payerId, tenantId }, select: { id: true, name: true } });
    if (!payer) throw new TenantScopeError("payer", input.payerId);
    const claims = await tx.claim.findMany({
      where: {
        tenantId,
        payerId: payer.id,
        status: "OPEN",
        batchId: null,
        ...(input.clinicId ? { clinicId: input.clinicId } : {}),
        ...(input.claimIds ? { id: { in: input.claimIds } } : {}),
        // Claims made by the day they go (and up to the day asked).
        claimedAt: { lte: sentAt, ...(input.upTo ? { lt: fromDateKey(nextDay(input.upTo), timezone)! } : {}) },
      },
      orderBy: [{ claimedAt: "asc" }, { sequence: "asc" }],
      select: { id: true, clinicId: true, amount: true },
    });
    if (input.claimIds && claims.length !== new Set(input.claimIds).size) {
      throw new FinanceError(409, "not_open", "some claims are sent already or are not this payer's", { message: "Some of those claims are sent already, or are not this payer's." });
    }
    if (!claims.length) throw new FinanceError(409, "nothing_to_send", "no claim to send", { message: `There is no claim to send to ${payer.name}.` });
    const made: BatchSummary[] = [];
    for (const clinicId of new Set(claims.map((c) => c.clinicId))) {
      const ours = claims.filter((c) => c.clinicId === clinicId);
      const { sequence, number } = await takeNumber(tx, tenantId, clinicId, "CLAIM_BATCH");
      const batch = await tx.claimBatch.create({
        data: { tenantId, clinicId, payerId: payer.id, sequence, number, sentAt, sentById: actor.id ?? null, reference: input.reference ?? null, note: input.note ?? null },
        select: { id: true },
      });
      // Only claims still not sent: two people sending at once never send one twice.
      const moved = await tx.claim.updateMany({ where: { tenantId, id: { in: ours.map((c) => c.id) }, status: "OPEN", batchId: null }, data: { batchId: batch.id, status: "SENT" } });
      if (moved.count !== ours.length) throw new FinanceError(409, "conflict", "the claims changed while sending", { message: "Someone sent some of these claims just now: look again." });
      made.push({ id: batch.id, number, claims: ours.length, amount: ours.reduce((s, c) => s + c.amount, 0) });
    }
    return made;
  });
  for (const b of batches) {
    await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "claim_batch.send", entity: "ClaimBatch", entityId: b.id, after: { payerId: input.payerId, number: b.number, claims: b.claims, amount: b.amount, sentOn: input.sentOn ?? today } });
  }
  return batches;
}

const nextDay = (key: string) => keyOf(new Date(new Date(`${key}T00:00:00Z`).getTime() + DAY));

export interface BatchRow {
  id: string;
  number: string;
  payerId: string;
  payerName: string;
  clinicName: string;
  sentAt: string;
  /** When the payer should have paid it by, by its days to pay. */
  dueBy: string;
  reference: string | null;
  claims: number;
  amount: number;
  paid: number;
  refused: number;
  owed: number;
  overdue: boolean;
}

const batchSelect = {
  id: true,
  number: true,
  sentAt: true,
  reference: true,
  note: true,
  payer: { select: { id: true, name: true, paymentDays: true } },
  clinic: { select: { name: true } },
  claims: { select: { status: true, amount: true, lines: { select: { payerShare: true, answers: answersOf } } } },
} satisfies Prisma.ClaimBatchSelect;

function batchRow(b: Prisma.ClaimBatchGetPayload<{ select: typeof batchSelect }>, now: Date): BatchRow {
  const live = b.claims.filter((c) => c.status !== "CANCELLED");
  const sums = sumAnswers(live.flatMap((c) => c.lines));
  const dueBy = new Date(b.sentAt.getTime() + b.payer.paymentDays * DAY);
  return {
    id: b.id,
    number: b.number,
    payerId: b.payer.id,
    payerName: b.payer.name,
    clinicName: b.clinic.name,
    sentAt: b.sentAt.toISOString(),
    dueBy: dueBy.toISOString(),
    reference: b.reference,
    claims: live.length,
    amount: live.reduce((s, c) => s + c.amount, 0),
    paid: sums.paid,
    refused: sums.refused,
    owed: sums.owed,
    overdue: sums.owed > 0 && now.getTime() > dueBy.getTime(),
  };
}

export async function listBatches(tenantId: string, opts: { payerId?: string; open?: boolean; take?: number } = {}, now: Date = new Date()): Promise<BatchRow[]> {
  const rows = await db.claimBatch.findMany({
    where: { tenantId, ...(opts.payerId ? { payerId: opts.payerId } : {}) },
    orderBy: [{ sentAt: "desc" }, { sequence: "desc" }],
    take: opts.take ?? 100,
    select: batchSelect,
  });
  const batches = rows.map((b) => batchRow(b, now));
  return opts.open ? batches.filter((b) => b.owed > 0) : batches;
}

export interface PayerPaymentRow {
  id: string;
  payerName: string;
  batchNumber: string | null;
  amount: number;
  refused: number;
  method: string;
  methodLabel: string;
  paidAt: string;
  reference: string | null;
  note: string | null;
  voided: boolean;
  voidReason: string | null;
}

export async function listPayerPayments(tenantId: string, opts: { payerId?: string; batchId?: string; take?: number } = {}): Promise<PayerPaymentRow[]> {
  const rows = await db.payerPayment.findMany({
    where: { tenantId, ...(opts.payerId ? { payerId: opts.payerId } : {}), ...(opts.batchId ? { batchId: opts.batchId } : {}) },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    take: opts.take ?? 50,
    select: { id: true, amount: true, method: true, paidAt: true, reference: true, note: true, voidedAt: true, voidReason: true, payer: { select: { name: true } }, batch: { select: { number: true } }, answers: { select: { refused: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    payerName: p.payer.name,
    batchNumber: p.batch?.number ?? null,
    amount: p.amount,
    refused: p.answers.reduce((s, a) => s + a.refused, 0),
    method: p.method,
    methodLabel: METHOD_LABELS[p.method],
    paidAt: p.paidAt.toISOString(),
    reference: p.reference,
    note: p.note,
    voided: Boolean(p.voidedAt),
    voidReason: p.voidReason,
  }));
}

export interface BatchDetail extends BatchRow {
  note: string | null;
  claimList: ClaimDetail[];
  payments: PayerPaymentRow[];
}

export async function getBatch(tenantId: string, id: string, now: Date = new Date()): Promise<BatchDetail> {
  const b = await db.claimBatch.findFirst({ where: { id, tenantId }, select: { ...batchSelect, claims: { orderBy: { sequence: "asc" }, select: { id: true, status: true, amount: true, lines: { select: { payerShare: true, answers: answersOf } } } } } });
  if (!b) throw new TenantScopeError("claim_batch", id);
  const [claimList, payments] = await Promise.all([Promise.all(b.claims.map((c) => getClaim(tenantId, c.id, now))), listPayerPayments(tenantId, { batchId: id })]);
  return { ...batchRow(b, now), note: b.note, claimList, payments };
}

/** The batch as the payer gets it: a line for each piece of work claimed. */
export async function batchCsv(tenantId: string, id: string): Promise<{ filename: string; csv: string }> {
  const batch = await getBatch(tenantId, id);
  const timezone = await getTenantTimezone(tenantId);
  const rows = batch.claimList.flatMap((c) =>
    c.lines.map((l) => [
      c.number,
      c.patientName,
      c.memberNumber,
      c.invoiceNumber ?? "",
      dateKeyInTz(new Date(l.workedAt), timezone),
      l.description,
      l.amount + l.contractDiscount,
      l.contractDiscount,
      l.patientShare,
      l.payerShare,
      l.approvalNumber ?? "",
      c.status === "CANCELLED" ? "cancelled" : "",
    ]),
  );
  const csv = toCsv(
    ["Claim", "Patient", "Member no.", "Invoice", "Day of the work", "Work", "Price (EGP)", "Contract discount (EGP)", "Patient's share (EGP)", "Claimed (EGP)", "Approval no.", "Note"],
    [...rows, ["Total", "", "", "", "", "", "", "", "", batch.amount, "", ""]],
  );
  return { filename: `${batch.number}.csv`, csv };
}

// ── The payer's answer ───────────────────────────────────────────────────────

export const AnswerLine = z
  .object({
    claimLineId: zId,
    paid: z.number().int("Whole EGP").min(0, "Zero or more").default(0),
    refused: z.number().int("Whole EGP").min(0, "Zero or more").default(0),
    reason: z.enum(REFUSAL_REASONS).optional(),
    /** The clinic gives up what is refused instead of asking the patient (the owner's decision). */
    writeOff: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.paid + v.refused <= 0) ctx.addIssue({ code: "custom", path: ["paid"], message: "Paid or refused" });
    if (v.refused > 0 && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Why the payer refused it" });
    if (v.writeOff && v.refused <= 0) ctx.addIssue({ code: "custom", path: ["writeOff"], message: "Only what is refused is written off" });
  });

export const PayerAnswerInput = z
  .object({
    payerId: zId,
    batchId: zOptionalText(64),
    paidOn: zDayKey,
    method: z.enum(PAYMENT_METHODS).default("BANK_TRANSFER"),
    reference: zOptionalText(120),
    note: zOptionalText(500),
    lines: z.array(AnswerLine).min(1, "At least one line").max(2000),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.lines.map((l) => l.claimLineId)).size !== v.lines.length) ctx.addIssue({ code: "custom", path: ["lines"], message: "A line is answered once" });
  });

export const PayerPaymentVoid = z.object({ reason: zText(300).min(3, "Say why it is voided") });

/** A claim's status from what is owed on it. */
async function refreshClaims(tx: Tx, tenantId: string, claimIds: Iterable<string>) {
  for (const id of new Set(claimIds)) {
    const c = await tx.claim.findFirst({ where: { id, tenantId }, select: { status: true, batchId: true, lines: { select: { payerShare: true, answers: answersOf } } } });
    if (!c || c.status === "CANCELLED") continue;
    const status = sumAnswers(c.lines).owed <= 0 ? "SETTLED" : c.batchId ? "SENT" : "OPEN";
    if (status !== c.status) await tx.claim.update({ where: { id }, data: { status } });
  }
}

/**
 * Take back what an invoice is paid beyond its total (a refusal voided, so the
 * claim settles more again): the latest allocations first, as credit again.
 */
async function trimOverSettled(tx: Tx, tenantId: string, invoiceId: string) {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { total: true, status: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "DRAFT") return;
  const s = await settledOn(tx, tenantId, invoiceId);
  let excess = s.paid + s.writtenOff + s.claimed - invoice.total;
  if (excess <= 0) return;
  const allocations = await tx.paymentAllocation.findMany({ where: { tenantId, invoiceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, amount: true } });
  for (const a of allocations) {
    if (excess <= 0) break;
    if (a.amount <= excess) await tx.paymentAllocation.delete({ where: { id: a.id } });
    else await tx.paymentAllocation.update({ where: { id: a.id }, data: { amount: a.amount - excess } });
    excess -= Math.min(a.amount, excess);
  }
}

export interface AnswerResult {
  paymentId: string;
  paid: number;
  refused: number;
  writtenOff: number;
  claims: number;
}

/** Record a payer's answer: the money it paid and what it refused, line by line (the owner). */
export async function recordPayerAnswer(tenantId: string, rawInput: unknown, actor: InsuranceActor = {}, opts: { now?: Date } = {}): Promise<AnswerResult> {
  const input = PayerAnswerInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  if (input.paidOn > dateKeyInTz(now, timezone)) throw new z.ZodError([{ code: "custom", path: ["paidOn"], message: "Not a day ahead" }]);
  const paidAt = momentOf(input.paidOn, timezone, now);
  const result = await db.$transaction(async (tx) => {
    const payer = await tx.payer.findFirst({ where: { id: input.payerId, tenantId }, select: { id: true, name: true } });
    if (!payer) throw new TenantScopeError("payer", input.payerId);
    if (input.batchId) {
      const batch = await tx.claimBatch.findFirst({ where: { id: input.batchId, tenantId, payerId: payer.id }, select: { id: true } });
      if (!batch) throw new TenantScopeError("claim_batch", input.batchId);
    }
    const lines = await tx.claimLine.findMany({
      where: { tenantId, id: { in: input.lines.map((l) => l.claimLineId) } },
      select: {
        id: true,
        payerShare: true,
        answers: answersOf,
        claim: { select: { id: true, number: true, status: true, payerId: true, patientId: true, invoiceId: true, claimedAt: true } },
      },
    });
    const byId = new Map(lines.map((l) => [l.id, l]));
    for (const [i, l] of input.lines.entries()) {
      const line = byId.get(l.claimLineId);
      if (!line || line.claim.payerId !== payer.id) throw new TenantScopeError("claim_line", l.claimLineId);
      if (line.claim.status === "CANCELLED") throw new FinanceError(409, "cancelled", "the claim is cancelled", { message: `Claim ${line.claim.number} is cancelled.` });
      const owed = line.payerShare - line.answers.reduce((s, a) => s + a.paid + a.refused, 0);
      if (l.paid + l.refused > owed) throw new z.ZodError([{ code: "custom", path: ["lines", i, "paid"], message: `At most ${owed.toLocaleString("en-US")} EGP is owed on this line` }]);
      if (paidAt < line.claim.claimedAt) throw new z.ZodError([{ code: "custom", path: ["paidOn"], message: `Not before claim ${line.claim.number} was made` }]);
    }
    const paid = input.lines.reduce((s, l) => s + l.paid, 0);
    const payment = await tx.payerPayment.create({
      data: { tenantId, payerId: payer.id, batchId: input.batchId ?? null, amount: paid, method: input.method, paidAt, reference: input.reference ?? null, note: input.note ?? null, createdById: actor.id ?? null },
      select: { id: true },
    });
    let writtenOff = 0;
    const refusedBy = new Map<string, { amount: number; writtenOff: number }>();
    for (const l of input.lines) {
      const line = byId.get(l.claimLineId)!;
      let writeOffId: string | null = null;
      if (l.refused > 0 && l.writeOff) {
        const w = await tx.writeOff.create({
          data: {
            tenantId,
            patientId: line.claim.patientId,
            invoiceId: line.claim.invoiceId,
            amount: l.refused,
            reason: "PAYER_REFUSED",
            note: `${payer.name}: ${REFUSAL_REASON_LABELS[l.reason!]} (claim ${line.claim.number})`.slice(0, 300),
            writtenOffAt: paidAt,
            createdById: actor.id ?? null,
          },
          select: { id: true },
        });
        writeOffId = w.id;
        writtenOff += l.refused;
      }
      await tx.claimAnswer.create({ data: { tenantId, claimLineId: line.id, payerPaymentId: payment.id, paid: l.paid, refused: l.refused, refusalReason: l.refused > 0 ? l.reason! : null, writeOffId } });
      if (l.refused > 0) {
        const r = refusedBy.get(line.claim.patientId) ?? { amount: 0, writtenOff: 0 };
        r.amount += l.refused;
        if (l.writeOff) r.writtenOff += l.refused;
        refusedBy.set(line.claim.patientId, r);
      }
    }
    const claimIds = new Set(lines.map((l) => l.claim.id));
    await refreshClaims(tx, tenantId, claimIds);
    for (const invoiceId of new Set(lines.map((l) => l.claim.invoiceId))) await refreshInvoiceStatus(tx, tenantId, invoiceId);
    // What the patient owes again may be paid from their credit.
    await allocateFor(tx, tenantId, [...refusedBy.keys()], actor.id ?? null);
    for (const [patientId, r] of refusedBy) {
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId,
          kind: "INSURANCE",
          title: `Refused by ${payer.name}: ${r.amount.toLocaleString("en-US")} EGP`,
          body: r.writtenOff === r.amount ? "Written off by the clinic." : r.writtenOff ? `${(r.amount - r.writtenOff).toLocaleString("en-US")} EGP owed by the patient; the rest written off.` : "Owed by the patient.",
          refId: payment.id,
          occurredAt: paidAt,
        },
      });
    }
    return { paymentId: payment.id, paid, refused: input.lines.reduce((s, l) => s + l.refused, 0), writtenOff, claims: claimIds.size };
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "payer_payment.record",
    entity: "PayerPayment",
    entityId: result.paymentId,
    after: { payerId: input.payerId, batchId: input.batchId ?? null, paidOn: input.paidOn, method: input.method, reference: input.reference ?? null, paid: result.paid, refused: result.refused, writtenOff: result.writtenOff, lines: input.lines.length },
  });
  return result;
}

/** Void a payer's answer recorded by mistake (the owner): its lines are owed by the payer again, its write-offs voided. */
export async function voidPayerPayment(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<void> {
  const input = PayerPaymentVoid.parse(rawInput);
  const now = new Date();
  const before = await db.$transaction(async (tx) => {
    const payment = await tx.payerPayment.findFirst({
      where: { id, tenantId },
      select: { id: true, amount: true, voidedAt: true, payerId: true, answers: { select: { id: true, writeOffId: true, claimLine: { select: { claim: { select: { id: true, invoiceId: true, patientId: true } } } } } } },
    });
    if (!payment) throw new TenantScopeError("payer_payment", id);
    if (payment.voidedAt) throw new FinanceError(409, "invalid_state", "the payment is voided already", { message: "It is voided already." });
    await tx.payerPayment.update({ where: { id }, data: { voidedAt: now, voidedById: actor.id ?? null, voidReason: input.reason } });
    await tx.claimAnswer.updateMany({ where: { tenantId, payerPaymentId: id, voidedAt: null }, data: { voidedAt: now } });
    const writeOffIds = payment.answers.flatMap((a) => (a.writeOffId ? [a.writeOffId] : []));
    if (writeOffIds.length) await tx.writeOff.updateMany({ where: { tenantId, id: { in: writeOffIds }, voidedAt: null }, data: { voidedAt: now } });
    const claims = payment.answers.map((a) => a.claimLine.claim);
    await refreshClaims(tx, tenantId, claims.map((c) => c.id));
    for (const invoiceId of new Set(claims.map((c) => c.invoiceId))) {
      await trimOverSettled(tx, tenantId, invoiceId);
      await refreshInvoiceStatus(tx, tenantId, invoiceId);
    }
    await allocateFor(tx, tenantId, claims.map((c) => c.patientId), actor.id ?? null);
    return payment;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "payer_payment.void", entity: "PayerPayment", entityId: id, before: { amount: before.amount }, after: { reason: input.reason } });
}

/** What can be answered of a payer's claims: its lines still owed (a batch's, or every sent and unsent one). */
export async function answerContext(tenantId: string, payerId: string, opts: { batchId?: string } = {}) {
  const lines = await db.claimLine.findMany({
    where: { tenantId, claim: { payerId, status: { in: ["OPEN", "SENT"] }, ...(opts.batchId ? { batchId: opts.batchId } : {}) } },
    orderBy: [{ claim: { claimedAt: "asc" } }, { position: "asc" }],
    select: {
      id: true,
      description: true,
      payerShare: true,
      workedAt: true,
      answers: answersOf,
      claim: { select: { id: true, number: true, patient: { select: { fullName: true } }, coverage: { select: { memberNumber: true } }, batch: { select: { number: true } } } },
    },
  });
  return lines
    .map((l) => ({
      id: l.id,
      claimId: l.claim.id,
      claimNumber: l.claim.number,
      batchNumber: l.claim.batch?.number ?? null,
      patientName: l.claim.patient.fullName,
      memberNumber: l.claim.coverage.memberNumber,
      description: l.description,
      workedAt: l.workedAt.toISOString(),
      owed: l.payerShare - l.answers.reduce((s, a) => s + a.paid + a.refused, 0),
    }))
    .filter((l) => l.owed > 0);
}
