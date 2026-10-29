import type { ApprovalStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient, TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { procedureLabel } from "@/modules/finance/charges";
import { MAX_AMOUNT } from "@/modules/finance/constants";
import { FinanceError } from "@/modules/finance/errors";
import { APPROVAL_STATUS_LABELS, COVER_RELATION_LABELS, COVER_RELATIONS, PAYER_KIND_LABELS, type ApprovalStatusValue, type CoverRelationValue, type PayerKindValue } from "./constants";
import { limitUsed, toTerms } from "./claims";
import type { InsuranceActor } from "./payers";
import { contractOn, contractYear, within } from "./terms";

/**
 * A patient's covers and the approvals asked of their payers.
 *
 * A cover is the patient's card with a payer: its number, the plan, whose
 * card it is (the holder's own, or a family member's on it) and the days it
 * is valid. A patient has one cover on any day; one ending early (the patient
 * left the company) keeps its reason. A cover's days never leave out work its
 * claims are for.
 *
 * An approval is asked of the payer before work that needs one (its contract
 * says which), for planned work or in words, for an amount; the payer's
 * answer is recorded as it comes: its number, the amount approved and until
 * when, or why it refused. A claim line that needs one uses the amount
 * approved (modules/insurance/terms.ts). An approval is cancelled while no
 * claim uses it.
 */

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zMoney = z.number().int("Whole EGP").positive("More than zero").max(MAX_AMOUNT, "Too large");
const zId = zText(64).min(1);

const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);

const CoverFields = {
  memberNumber: zText(60).min(1, "The card's number"),
  plan: zOptionalText(80),
  employer: zOptionalText(120),
  relation: z.enum(COVER_RELATIONS).default("SELF"),
  validFrom: zDayKey,
  validTo: zDayKey.optional(),
  note: zOptionalText(500),
};
const daysInOrder = (v: { validFrom: string; validTo?: string }) => !v.validTo || v.validTo >= v.validFrom;

export const CoverInput = z.object({ payerId: zId, ...CoverFields }).refine(daysInOrder, { path: ["validTo"], message: "Not before its first day" });
export const CoverEdit = z.object(CoverFields).refine(daysInOrder, { path: ["validTo"], message: "Not before its first day" });
export const CoverEndInput = z.object({ endOn: zDayKey, reason: zText(300).min(3, "Say why the cover ends") });

export const ApprovalInput = z.object({
  coverageId: zId,
  /** The planned work it is asked for, when there is one. */
  procedureId: zOptionalText(64),
  description: zText(200).min(2, "Say what it is for"),
  amount: zMoney,
  /** The day it was asked (today when left out). */
  requestedOn: zDayKey.optional(),
  note: zOptionalText(500),
});

export const ApprovalAnswer = z.discriminatedUnion("status", [
  z.object({ status: z.literal("APPROVED"), approvalNumber: zText(60).min(1, "The payer's approval number"), approvedAmount: zMoney, validUntil: zDayKey.optional(), answeredOn: zDayKey.optional(), note: zOptionalText(500) }),
  z.object({ status: z.literal("REFUSED"), reason: zText(300).min(3, "Say why the payer refused"), answeredOn: zDayKey.optional(), note: zOptionalText(500) }),
]);

export const ApprovalCancel = z.object({ reason: zText(300).min(3, "Say why it is cancelled") });

export interface CoverDTO {
  id: string;
  payerId: string;
  payerName: string;
  payerKind: PayerKindValue;
  payerKindLabel: string;
  memberNumber: string;
  plan: string | null;
  employer: string | null;
  relation: CoverRelationValue;
  relationLabel: string;
  validFrom: string;
  validTo: string | null;
  endReason: string | null;
  note: string | null;
  /** Valid today. */
  active: boolean;
  /** The payer's contract today, in short. */
  terms: { copayPct: number; discountPct: number; annualLimit: number | null; approvalAbove: number | null } | null;
  /** The yearly limit this contract year: what claims took of it and what is left. */
  limit: { amount: number; used: number; left: number; from: string; to: string } | null;
  claims: number;
}

export interface ApprovalDTO {
  id: string;
  coverageId: string;
  payerName: string;
  description: string;
  procedure: { id: string; label: string } | null;
  amount: number;
  status: ApprovalStatusValue;
  statusLabel: string;
  requestedAt: string;
  approvalNumber: string | null;
  approvedAmount: number | null;
  validUntil: string | null;
  refusalReason: string | null;
  answeredAt: string | null;
  note: string | null;
  /** What claims took of the amount approved, and what is left. */
  used: number;
  left: number;
  /** Approved, and past its last day. */
  expired: boolean;
}

export interface PatientClaimRow {
  id: string;
  number: string;
  status: string;
  payerName: string;
  invoiceId: string;
  invoiceNumber: string | null;
  claimedAt: string;
  amount: number;
  paid: number;
  refused: number;
  owed: number;
}

export interface PatientInsurance {
  timezone: string;
  today: string;
  covers: CoverDTO[];
  /** The cover valid today. */
  current: CoverDTO | null;
  approvals: ApprovalDTO[];
  /** The patient's claims (for the roles that see claims). */
  claims: PatientClaimRow[] | null;
}

const coverInclude = { payer: { select: { id: true, name: true, kind: true, contracts: { include: { rules: true } } } }, _count: { select: { claims: true } } } satisfies Prisma.CoverageInclude;
type CoverRow = Prisma.CoverageGetPayload<{ include: typeof coverInclude }>;

const takenOf = (l: { payerShare: number; answers: { refused: number }[] }) => l.payerShare - l.answers.reduce((s, a) => s + a.refused, 0);

async function coverDTO(c: CoverRow, patientId: string, today: string, timezone: string, tenantId: string): Promise<CoverDTO> {
  const span = { validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null };
  const active = within(span, today);
  const contract = contractOn(c.payer.contracts.map(toTerms), active ? today : (span.validTo ?? today));
  let limit: CoverDTO["limit"] = null;
  if (contract && contract.annualLimit !== null) {
    const year = contractYear(contract.validFrom, active ? today : (span.validTo ?? today));
    const used = await limitUsed(db, tenantId, patientId, c.payer.id, year.from, year.to, timezone);
    limit = { amount: contract.annualLimit, used, left: Math.max(0, contract.annualLimit - used), from: year.from, to: year.to };
  }
  return {
    id: c.id,
    payerId: c.payer.id,
    payerName: c.payer.name,
    payerKind: c.payer.kind,
    payerKindLabel: PAYER_KIND_LABELS[c.payer.kind],
    memberNumber: c.memberNumber,
    plan: c.plan,
    employer: c.employer,
    relation: c.relation as CoverRelationValue,
    relationLabel: COVER_RELATION_LABELS[c.relation as CoverRelationValue] ?? c.relation,
    validFrom: span.validFrom,
    validTo: span.validTo,
    endReason: c.endReason,
    note: c.note,
    active,
    terms: contract ? { copayPct: contract.copayPct, discountPct: contract.discountPct, annualLimit: contract.annualLimit, approvalAbove: contract.approvalAbove } : null,
    limit,
    claims: c._count.claims,
  };
}

/** Everything about a patient's insurance: covers, approvals and (for the roles that see them) claims. */
export async function patientInsurance(tenantId: string, patientId: string, opts: { claims?: boolean; now?: Date } = {}): Promise<PatientInsurance> {
  await requireTenantPatient(tenantId, patientId);
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(opts.now ?? new Date(), timezone);
  const [covers, approvals, claims] = await Promise.all([
    db.coverage.findMany({ where: { tenantId, patientId }, orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }], include: coverInclude }),
    db.preApproval.findMany({
      where: { tenantId, patientId },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      include: {
        payer: { select: { name: true } },
        procedure: { select: { id: true, quantity: true, stages: true, priceItem: { select: { name: true } }, treatment: { select: { name: true } } } },
        claimLines: { where: { claim: { status: { not: "CANCELLED" } } }, select: { payerShare: true, answers: { where: { voidedAt: null }, select: { refused: true } } } },
      },
    }),
    opts.claims
      ? db.claim.findMany({
          where: { tenantId, patientId },
          orderBy: [{ claimedAt: "desc" }, { id: "desc" }],
          take: 50,
          select: {
            id: true,
            number: true,
            status: true,
            claimedAt: true,
            amount: true,
            invoiceId: true,
            invoice: { select: { number: true } },
            payer: { select: { name: true } },
            lines: { select: { payerShare: true, answers: { where: { voidedAt: null }, select: { paid: true, refused: true } } } },
          },
        })
      : Promise.resolve(null),
  ]);
  const coverDTOs = await Promise.all(covers.map((c) => coverDTO(c, patientId, today, timezone, tenantId)));
  return {
    timezone,
    today,
    covers: coverDTOs,
    current: coverDTOs.find((c) => c.active) ?? null,
    approvals: approvals.map((a) => {
      const used = a.claimLines.reduce((s, l) => s + takenOf(l), 0);
      const validUntil = a.validUntil ? keyOf(a.validUntil) : null;
      return {
        id: a.id,
        coverageId: a.coverageId,
        payerName: a.payer.name,
        description: a.description,
        procedure: a.procedure ? { id: a.procedure.id, label: procedureLabel(a.procedure) } : null,
        amount: a.amount,
        status: a.status,
        statusLabel: APPROVAL_STATUS_LABELS[a.status],
        requestedAt: a.requestedAt.toISOString(),
        approvalNumber: a.approvalNumber,
        approvedAmount: a.approvedAmount,
        validUntil,
        refusalReason: a.refusalReason,
        answeredAt: a.answeredAt?.toISOString() ?? null,
        note: a.note,
        used,
        left: a.status === "APPROVED" ? Math.max(0, (a.approvedAmount ?? 0) - used) : 0,
        expired: a.status === "APPROVED" && validUntil !== null && validUntil < today,
      };
    }),
    claims: claims
      ? claims.map((c) => {
          const paid = c.lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.paid, 0), 0);
          const refused = c.lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.refused, 0), 0);
          return {
            id: c.id,
            number: c.number,
            status: c.status,
            payerName: c.payer.name,
            invoiceId: c.invoiceId,
            invoiceNumber: c.invoice.number,
            claimedAt: c.claimedAt.toISOString(),
            amount: c.amount,
            paid,
            refused,
            owed: c.status === "CANCELLED" ? 0 : c.amount - paid - refused,
          };
        })
      : null,
  };
}

// ── Covers ───────────────────────────────────────────────────────────────────

const overlaps = (a: { validFrom: string; validTo: string | null }, b: { validFrom: string; validTo: string | null }) =>
  (a.validTo === null || b.validFrom <= a.validTo) && (b.validTo === null || a.validFrom <= b.validTo);

/** The patient's other covers must not share a day with this one. */
async function assertNoOverlap(tx: Prisma.TransactionClient, tenantId: string, patientId: string, span: { validFrom: string; validTo: string | null }, exceptId: string | null) {
  await tx.$queryRaw`SELECT id FROM "patients" WHERE id = ${patientId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const others = await tx.coverage.findMany({
    where: { tenantId, patientId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { validFrom: true, validTo: true, payer: { select: { name: true } } },
  });
  const clash = others.find((o) => overlaps({ validFrom: keyOf(o.validFrom), validTo: o.validTo ? keyOf(o.validTo) : null }, span));
  if (clash) {
    throw new FinanceError(409, "overlap", "the patient has another cover on those days", {
      message: `The patient is covered by ${clash.payer.name} from ${keyOf(clash.validFrom)}${clash.validTo ? ` to ${keyOf(clash.validTo)}` : ""}: end that cover first.`,
    });
  }
}

/** A cover's days must keep the work its claims are for. */
async function assertKeepsClaims(tx: Prisma.TransactionClient, tenantId: string, coverageId: string, span: { validFrom: string; validTo: string | null }, timezone: string) {
  const outside = await tx.claimLine.findFirst({
    where: {
      tenantId,
      claim: { coverageId, status: { not: "CANCELLED" } },
      OR: [{ workedAt: { lt: fromDateKey(span.validFrom, timezone)! } }, ...(span.validTo ? [{ workedAt: { gte: fromDateKey(nextDay(span.validTo), timezone)! } }] : [])],
    },
    select: { claim: { select: { number: true } } },
  });
  if (outside) {
    throw new FinanceError(409, "claimed", "the cover has claims for work outside those days", { message: `Claim ${outside.claim.number} is for work outside those days: the cover keeps them.` });
  }
}

const nextDay = (key: string) => keyOf(new Date(asDate(key).getTime() + 86_400_000));

export async function addCover(tenantId: string, patientId: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PatientInsurance> {
  const input = CoverInput.parse(rawInput);
  await requireTenantPatient(tenantId, patientId);
  const span = { validFrom: input.validFrom, validTo: input.validTo ?? null };
  const id = await db.$transaction(async (tx) => {
    const payer = await tx.payer.findFirst({ where: { id: input.payerId, tenantId }, select: { id: true, name: true, archivedAt: true } });
    if (!payer) throw new TenantScopeError("payer", input.payerId);
    if (payer.archivedAt) throw new FinanceError(409, "archived", "the payer is archived", { message: `${payer.name} no longer works with the clinic.` });
    await assertNoOverlap(tx, tenantId, patientId, span, null);
    const cover = await tx.coverage.create({
      data: {
        tenantId,
        patientId,
        payerId: payer.id,
        memberNumber: input.memberNumber,
        plan: input.plan ?? null,
        employer: input.employer ?? null,
        relation: input.relation,
        validFrom: asDate(input.validFrom),
        validTo: input.validTo ? asDate(input.validTo) : null,
        note: input.note ?? null,
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    await tx.timelineEvent.create({
      data: { tenantId, patientId, kind: "INSURANCE", title: `Covered by ${payer.name}`, body: `Card ${input.memberNumber}${input.plan ? ` · ${input.plan}` : ""} · from ${input.validFrom}${input.validTo ? ` to ${input.validTo}` : ""}`, refId: cover.id, occurredAt: new Date() },
    });
    return cover.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "coverage.create", entity: "Coverage", entityId: id, after: { patientId, ...input } });
  return patientInsurance(tenantId, patientId, { claims: true });
}

export async function updateCover(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PatientInsurance> {
  const input = CoverEdit.parse(rawInput);
  const timezone = await getTenantTimezone(tenantId);
  const span = { validFrom: input.validFrom, validTo: input.validTo ?? null };
  const before = await db.$transaction(async (tx) => {
    const cover = await tx.coverage.findFirst({ where: { id, tenantId } });
    if (!cover) throw new TenantScopeError("coverage", id);
    await assertNoOverlap(tx, tenantId, cover.patientId, span, id);
    await assertKeepsClaims(tx, tenantId, id, span, timezone);
    await tx.coverage.update({
      where: { id },
      data: {
        memberNumber: input.memberNumber,
        plan: input.plan ?? null,
        employer: input.employer ?? null,
        relation: input.relation,
        validFrom: asDate(input.validFrom),
        validTo: input.validTo ? asDate(input.validTo) : null,
        note: input.note ?? null,
        ...(input.validTo ? {} : { endReason: null, endedAt: null }),
      },
    });
    return cover;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "coverage.update",
    entity: "Coverage",
    entityId: id,
    before: { memberNumber: before.memberNumber, plan: before.plan, relation: before.relation, validFrom: keyOf(before.validFrom), validTo: before.validTo ? keyOf(before.validTo) : null },
    after: input,
  });
  return patientInsurance(tenantId, before.patientId, { claims: true });
}

/** End a cover on a day, with the reason (the patient left the company, the policy lapsed). */
export async function endCover(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PatientInsurance> {
  const input = CoverEndInput.parse(rawInput);
  const timezone = await getTenantTimezone(tenantId);
  const before = await db.$transaction(async (tx) => {
    const cover = await tx.coverage.findFirst({ where: { id, tenantId }, include: { payer: { select: { name: true } } } });
    if (!cover) throw new TenantScopeError("coverage", id);
    if (input.endOn < keyOf(cover.validFrom)) throw new z.ZodError([{ code: "custom", path: ["endOn"], message: "Not before the cover's first day" }]);
    if (cover.validTo && input.endOn > keyOf(cover.validTo)) throw new z.ZodError([{ code: "custom", path: ["endOn"], message: "The cover ends before then already" }]);
    await assertKeepsClaims(tx, tenantId, id, { validFrom: keyOf(cover.validFrom), validTo: input.endOn }, timezone);
    await tx.coverage.update({ where: { id }, data: { validTo: asDate(input.endOn), endReason: input.reason, endedAt: new Date() } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: cover.patientId, kind: "INSURANCE", title: `Cover by ${cover.payer.name} ends on ${input.endOn}`, body: input.reason, refId: id, occurredAt: new Date() },
    });
    return cover;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "coverage.end", entity: "Coverage", entityId: id, before: { validTo: before.validTo ? keyOf(before.validTo) : null }, after: input });
  return patientInsurance(tenantId, before.patientId, { claims: true });
}

// ── Approvals ────────────────────────────────────────────────────────────────

/** The work a patient might ask an approval for: what is planned or under way, and the last months' work. */
export async function approvalOptions(tenantId: string, patientId: string, now: Date = new Date()) {
  await requireTenantPatient(tenantId, patientId);
  const since = new Date(now.getTime() - 92 * 86_400_000);
  const procedures = await db.procedure.findMany({
    where: { tenantId, patientId, ...notDeleted, OR: [{ status: { in: ["PLANNED", "STARTED"] } }, { status: "SIGNED", performedAt: { gte: since } }] },
    orderBy: { performedAt: "desc" },
    take: 30,
    select: { id: true, status: true, price: true, discount: true, quantity: true, stages: true, performedAt: true, priceItem: { select: { name: true } }, treatment: { select: { name: true } } },
  });
  return procedures.map((p) => ({ id: p.id, label: procedureLabel(p), status: p.status, amount: Math.max(0, p.price - p.discount), performedAt: p.performedAt.toISOString() }));
}

export async function requestApproval(tenantId: string, patientId: string, rawInput: unknown, actor: InsuranceActor = {}, opts: { now?: Date } = {}): Promise<PatientInsurance> {
  const input = ApprovalInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(now, timezone);
  if (input.requestedOn && input.requestedOn > today) throw new z.ZodError([{ code: "custom", path: ["requestedOn"], message: "Not a day ahead" }]);
  const requestedAt = input.requestedOn && input.requestedOn !== today ? new Date(fromDateKey(input.requestedOn, timezone)!.getTime() + 12 * 3_600_000) : now;
  const id = await db.$transaction(async (tx) => {
    const cover = await tx.coverage.findFirst({ where: { id: input.coverageId, tenantId, patientId }, select: { id: true, payerId: true, payer: { select: { name: true } } } });
    if (!cover) throw new TenantScopeError("coverage", input.coverageId);
    if (input.procedureId) {
      const p = await tx.procedure.findFirst({ where: { id: input.procedureId, tenantId, patientId, ...notDeleted }, select: { id: true } });
      if (!p) throw new TenantScopeError("procedure", input.procedureId);
    }
    const approval = await tx.preApproval.create({
      data: {
        tenantId,
        patientId,
        coverageId: cover.id,
        payerId: cover.payerId,
        procedureId: input.procedureId ?? null,
        description: input.description,
        amount: input.amount,
        requestedAt,
        requestedById: actor.id ?? null,
        note: input.note ?? null,
      },
      select: { id: true },
    });
    await tx.timelineEvent.create({
      data: { tenantId, patientId, kind: "INSURANCE", title: `Approval asked of ${cover.payer.name}: ${input.description}`, body: `${input.amount.toLocaleString("en-US")} EGP`, refId: approval.id, occurredAt: requestedAt },
    });
    return approval.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "approval.request", entity: "PreApproval", entityId: id, after: { patientId, ...input } });
  return patientInsurance(tenantId, patientId, { claims: true });
}

/** The payer's answer to an approval asked of it. */
export async function answerApproval(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}, opts: { now?: Date } = {}): Promise<PatientInsurance> {
  const input = ApprovalAnswer.parse(rawInput);
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(now, timezone);
  if (input.answeredOn && input.answeredOn > today) throw new z.ZodError([{ code: "custom", path: ["answeredOn"], message: "Not a day ahead" }]);
  const answeredAt = input.answeredOn && input.answeredOn !== today ? new Date(fromDateKey(input.answeredOn, timezone)!.getTime() + 12 * 3_600_000) : now;
  const approval = await db.$transaction(async (tx) => {
    const a = await tx.preApproval.findFirst({ where: { id, tenantId }, include: { payer: { select: { name: true } } } });
    if (!a) throw new TenantScopeError("approval", id);
    if (a.status !== "REQUESTED") throw new FinanceError(409, "invalid_state", "the approval is answered already", { message: "The payer's answer is in already." });
    if (input.answeredOn && answeredAt < a.requestedAt && dateKeyInTz(a.requestedAt, timezone) > input.answeredOn) {
      throw new z.ZodError([{ code: "custom", path: ["answeredOn"], message: "Not before it was asked" }]);
    }
    if (input.status === "APPROVED" && input.validUntil && input.validUntil < dateKeyInTz(answeredAt, timezone)) {
      throw new z.ZodError([{ code: "custom", path: ["validUntil"], message: "Not before the day of the answer" }]);
    }
    const data: Prisma.PreApprovalUpdateInput =
      input.status === "APPROVED"
        ? { status: "APPROVED", approvalNumber: input.approvalNumber, approvedAmount: input.approvedAmount, validUntil: input.validUntil ? asDate(input.validUntil) : null, answeredAt, answeredById: actor.id ?? null, ...(input.note ? { note: input.note } : {}) }
        : { status: "REFUSED", refusalReason: input.reason, answeredAt, answeredById: actor.id ?? null, ...(input.note ? { note: input.note } : {}) };
    await tx.preApproval.update({ where: { id }, data });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: a.patientId,
        kind: "INSURANCE",
        title: input.status === "APPROVED" ? `Approved by ${a.payer.name}: ${a.description}` : `Refused by ${a.payer.name}: ${a.description}`,
        body: input.status === "APPROVED" ? `No. ${input.approvalNumber} · ${input.approvedAmount.toLocaleString("en-US")} EGP${input.validUntil ? ` · until ${input.validUntil}` : ""}` : input.reason,
        refId: id,
        occurredAt: answeredAt,
      },
    });
    return a;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "approval.answer", entity: "PreApproval", entityId: id, after: input });
  return patientInsurance(tenantId, approval.patientId, { claims: true });
}

export async function cancelApproval(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PatientInsurance> {
  const input = ApprovalCancel.parse(rawInput);
  const approval = await db.$transaction(async (tx) => {
    const a = await tx.preApproval.findFirst({ where: { id, tenantId }, select: { id: true, patientId: true, status: true, note: true, _count: { select: { claimLines: { where: { claim: { status: { not: "CANCELLED" } } } } } } } });
    if (!a) throw new TenantScopeError("approval", id);
    if (a.status === "CANCELLED" || a.status === "REFUSED") throw new FinanceError(409, "invalid_state", "the approval is closed", { message: a.status === "CANCELLED" ? "It is cancelled already." : "The payer refused it." });
    if (a._count.claimLines) throw new FinanceError(409, "used", "a claim uses the approval", { message: "A claim uses this approval: it stays." });
    const status: ApprovalStatus = "CANCELLED";
    await tx.preApproval.update({ where: { id }, data: { status, answeredAt: new Date(), answeredById: actor.id ?? null, note: [a.note, `Cancelled: ${input.reason}`].filter(Boolean).join("\n").slice(0, 500) } });
    return a;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "approval.cancel", entity: "PreApproval", entityId: id, after: input });
  return patientInsurance(tenantId, approval.patientId, { claims: true });
}

/** The payers a new cover can be with: those still working with the clinic. */
export async function payerOptions(tenantId: string) {
  const payers = await db.payer.findMany({ where: { tenantId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, kind: true } });
  return payers.map((p) => ({ id: p.id, name: p.name, kind: p.kind, kindLabel: PAYER_KIND_LABELS[p.kind] }));
}

export interface ApprovalRow extends ApprovalDTO {
  patientId: string;
  patientName: string;
  memberNumber: string;
}

/** Approvals across patients: those waiting for the payer's answer (oldest first), or every one of them. */
export async function listApprovals(tenantId: string, opts: { waiting?: boolean; take?: number; now?: Date } = {}): Promise<ApprovalRow[]> {
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(opts.now ?? new Date(), timezone);
  const rows = await db.preApproval.findMany({
    where: { tenantId, ...(opts.waiting ? { status: "REQUESTED" } : {}) },
    orderBy: opts.waiting ? [{ requestedAt: "asc" }, { id: "asc" }] : [{ requestedAt: "desc" }, { id: "desc" }],
    take: opts.take ?? 100,
    include: {
      payer: { select: { name: true } },
      patient: { select: { id: true, fullName: true } },
      coverage: { select: { memberNumber: true } },
      procedure: { select: { id: true, quantity: true, stages: true, priceItem: { select: { name: true } }, treatment: { select: { name: true } } } },
      claimLines: { where: { claim: { status: { not: "CANCELLED" } } }, select: { payerShare: true, answers: { where: { voidedAt: null }, select: { refused: true } } } },
    },
  });
  return rows.map((a) => {
    const used = a.claimLines.reduce((s, l) => s + takenOf(l), 0);
    const validUntil = a.validUntil ? keyOf(a.validUntil) : null;
    return {
      id: a.id,
      coverageId: a.coverageId,
      payerName: a.payer.name,
      description: a.description,
      procedure: a.procedure ? { id: a.procedure.id, label: procedureLabel(a.procedure) } : null,
      amount: a.amount,
      status: a.status,
      statusLabel: APPROVAL_STATUS_LABELS[a.status],
      requestedAt: a.requestedAt.toISOString(),
      approvalNumber: a.approvalNumber,
      approvedAmount: a.approvedAmount,
      validUntil,
      refusalReason: a.refusalReason,
      answeredAt: a.answeredAt?.toISOString() ?? null,
      note: a.note,
      used,
      left: a.status === "APPROVED" ? Math.max(0, (a.approvedAmount ?? 0) - used) : 0,
      expired: a.status === "APPROVED" && validUntil !== null && validUntil < today,
      patientId: a.patient.id,
      patientName: a.patient.fullName,
      memberNumber: a.coverage.memberNumber,
    };
  });
}

export interface MemberRow {
  coverId: string;
  patientId: string;
  patientName: string;
  memberNumber: string;
  plan: string | null;
  relationLabel: string;
  validFrom: string;
  validTo: string | null;
  active: boolean;
}

/** A payer's members: its covers, those valid today first. */
export async function payerMembers(tenantId: string, payerId: string, now: Date = new Date()): Promise<MemberRow[]> {
  const today = dateKeyInTz(now, await getTenantTimezone(tenantId));
  const covers = await db.coverage.findMany({
    where: { tenantId, payerId },
    orderBy: [{ validFrom: "desc" }],
    take: 500,
    select: { id: true, memberNumber: true, plan: true, relation: true, validFrom: true, validTo: true, patient: { select: { id: true, fullName: true } } },
  });
  return covers
    .map((c) => {
      const span = { validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null };
      return {
        coverId: c.id,
        patientId: c.patient.id,
        patientName: c.patient.fullName,
        memberNumber: c.memberNumber,
        plan: c.plan,
        relationLabel: COVER_RELATION_LABELS[c.relation as CoverRelationValue] ?? c.relation,
        ...span,
        active: within(span, today),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.patientName.localeCompare(b.patientName));
}
