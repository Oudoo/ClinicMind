import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted, systemDb, withTenant } from "@/lib/db";
import { audit } from "@/lib/audit";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import { requireTenantPatient, TenantScopeError } from "@/lib/tenant-scope";
import { formatDateInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { publicBaseUrl, looksLikeToken } from "@/modules/concierge/tokens";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import { applyContractDiscounts, cancelInvoiceClaimsTx, claimInvoiceTx } from "@/modules/insurance/claims";
import { allocateCredit, allocateFor, claimedOn, claimsSettling, payableBy, refreshInvoiceStatus } from "./allocations";
import { defaultClinicId, takeNumber } from "./documents";
import { FinanceError } from "./errors";

/**
 * Invoices: what a patient is billed, built from their charges (one branch's
 * per invoice). A draft has no number and can be changed or discarded;
 * issuing gives it the branch's next number (no gaps) and puts the patient's
 * credit towards it. From then on it is never deleted and its lines never
 * change (the database refuses it): it is paid in part or in full as money is
 * allocated, or cancelled with a reason and a numbered credit note, which
 * gives back what was allocated to it as credit. Printed and sent in Arabic
 * or English; the patient's copy is a link that needs no sign-in.
 *
 * A covered patient's draft takes the contract's discount on covered work;
 * issuing it makes the claims for the payer's share (modules/insurance/claims.ts)
 * before the patient's credit goes towards the rest.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id?: string | null; email?: string | null; ip?: string | null };

/** Invoices that hold their charges: a charge is billed on one of these at most. */
const LIVE = ["DRAFT", "ISSUED", "PART_PAID", "PAID"] as const;
const ISSUED = ["ISSUED", "PART_PAID", "PAID"] as const;

export const INVOICE_LANGUAGES = ["en", "ar"] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

const zId = zText(64).min(1);

export const InvoiceDraftInput = z.object({
  patientId: zId,
  /** The charges to bill; all the patient's unbilled charges of one branch when not given. */
  chargeIds: z.array(zId).min(1).max(200).optional(),
  language: z.enum(INVOICE_LANGUAGES).optional(),
  note: zOptionalText(500),
});

export const InvoiceDraftUpdate = z.object({
  language: z.enum(INVOICE_LANGUAGES).optional(),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(500).nullable().optional()),
  /** Lines to take off the draft (their charges go back to unbilled). */
  removeChargeIds: z.array(zId).max(200).optional(),
});

export const InvoiceCancelInput = z.object({ reason: zText(300).min(3, "Say why the invoice is cancelled") });

export const InvoiceListQuery = z.object({
  patientId: zOptionalText(64),
  /** With patientId: the invoices that patient's payments can go towards (a head's include the family's). */
  payable: z.preprocess((v) => v === "1" || v === "true" || v === true, z.boolean()).default(false),
  status: z.enum(["DRAFT", "ISSUED", "PART_PAID", "PAID", "CANCELLED", "OPEN"]).optional(),
  q: zOptionalText(60),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export class InvoiceNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `invoice ${id} not found in tenant`, { entity: "invoice" });
    this.name = "InvoiceNotFoundError";
  }
}

export function invoiceState(status: string, action: string, message: string) {
  return new FinanceError(409, "invalid_state", `a ${status} invoice cannot be ${action}`, { status, action, message });
}

// ── What can be billed ───────────────────────────────────────────────────────

export interface BillableCharge {
  id: string;
  description: string;
  amount: number;
  chargedAt: Date;
  clinicId: string;
  procedureId: string | null;
  /** A discount: the charge it takes off. */
  discountOfId: string | null;
}

/**
 * The patient's charges on no invoice yet (a cancelled invoice gives its
 * charges back), leaving out charges of nothing and any charge whose
 * reversal is unbilled too (the two cancel out).
 */
export async function billableCharges(tx: Tx, tenantId: string, patientId: string): Promise<BillableCharge[]> {
  const fallback = await defaultClinicId(tx, tenantId);
  const rows = await tx.charge.findMany({
    where: { tenantId, patientId, amount: { not: 0 }, invoiceLines: { none: { invoice: { status: { in: [...LIVE] } } } } },
    select: { id: true, description: true, amount: true, chargedAt: true, clinicId: true, procedureId: true, reversalOfId: true, discountOfId: true },
    orderBy: [{ chargedAt: "asc" }, { createdAt: "asc" }],
  });
  const unbilled = new Set(rows.map((r) => r.id));
  const cancelled = new Set(rows.filter((r) => r.reversalOfId && unbilled.has(r.reversalOfId)).flatMap((r) => [r.id, r.reversalOfId!]));
  return rows
    .filter((r) => !cancelled.has(r.id))
    .flatMap((r) => {
      const clinicId = r.clinicId ?? fallback;
      return clinicId ? [{ id: r.id, description: r.description, amount: r.amount, chargedAt: r.chargedAt, clinicId, procedureId: r.procedureId, discountOfId: r.discountOfId }] : [];
    });
}

export async function listBillable(tenantId: string, patientId: string) {
  await requireTenantPatient(tenantId, patientId);
  const charges = await db.$transaction((tx) => billableCharges(tx, tenantId, patientId));
  return { charges: charges.map((c) => ({ ...c, chargedAt: c.chargedAt.toISOString() })), total: charges.reduce((s, c) => s + c.amount, 0) };
}

// ── Reading ──────────────────────────────────────────────────────────────────

const invoiceInclude = {
  clinic: { select: { id: true, name: true, code: true, address: true, phone: true } },
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, language: true } },
  lines: { orderBy: { position: "asc" }, select: { id: true, chargeId: true, description: true, amount: true, chargedAt: true, charge: { select: { discountOfId: true } } } },
  allocations: {
    orderBy: { createdAt: "asc" },
    select: { amount: true, createdAt: true, payment: { select: { id: true, receiptNumber: true, kind: true, method: true, paidAt: true } } },
  },
  creditNote: { select: { number: true, amount: true, reason: true, issuedAt: true } },
  writeOffs: { where: { voidedAt: null }, orderBy: { writtenOffAt: "asc" }, select: { amount: true, reason: true, note: true, writtenOffAt: true } },
  claims: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      status: true,
      amount: true,
      payer: { select: { name: true } },
      coverage: { select: { memberNumber: true } },
      lines: { select: { payerShare: true, answers: { where: { voidedAt: null }, select: { paid: true, refused: true } } } },
    },
  },
} as const;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

export interface InvoiceDTO {
  id: string;
  number: string | null;
  status: string;
  language: InvoiceLanguage;
  total: number;
  paid: number;
  /** Written off by the owner (none on a cancelled invoice). */
  writtenOff: number;
  due: number;
  note: string | null;
  createdAt: string;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  sentAt: string | null;
  clinicName: string;
  tenantName: string;
  timezone: string;
  clinic: { id: string; name: string; code: string | null; address: string | null; phone: string | null };
  patient: { id: string; fullName: string; phone: string | null; language: string };
  lines: { id: string; chargeId: string; description: string; amount: number; chargedAt: string }[];
  payments: { receiptNumber: string | null; method: string; paidAt: string; amount: number }[];
  writeOffs: { amount: number; reason: string; note: string | null; writtenOffAt: string }[];
  /** What the payers' claims settle of it: their shares, less what they refused. */
  claimed: number;
  /** The claims made for it (a cancelled one with a cancelled invoice). */
  claims: { id: string; number: string; status: string; payerName: string; memberNumber: string; amount: number; paid: number; refused: number }[];
  creditNote: { number: string; amount: number; reason: string; issuedAt: string } | null;
  /** The charges on the lines that are discounts, and of what (so a draft's discount stays with its charge). */
  discountOf: Record<string, string>;
}

function toDTO(row: InvoiceRow, tenantName: string, timezone: string): InvoiceDTO {
  const paid = row.status === "CANCELLED" ? 0 : row.allocations.reduce((s, a) => s + a.amount, 0);
  const writtenOff = row.status === "CANCELLED" ? 0 : row.writeOffs.reduce((s, w) => s + w.amount, 0);
  const claimed = row.status === "CANCELLED" ? 0 : claimedOn(row.claims.filter((c) => c.status !== "CANCELLED"));
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    language: row.language === "ar" ? "ar" : "en",
    total: row.total,
    paid,
    writtenOff,
    due: row.status === "CANCELLED" || row.status === "DRAFT" ? 0 : Math.max(0, row.total - paid - writtenOff - claimed),
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    issuedAt: row.issuedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    sentAt: row.sentAt?.toISOString() ?? null,
    clinicName: row.clinic.name,
    tenantName,
    timezone,
    clinic: row.clinic,
    patient: { id: row.patient.id, fullName: row.patient.fullName, phone: row.patient.whatsapp ?? row.patient.phone, language: row.patient.language },
    lines: row.lines.map(({ charge: _charge, ...l }) => ({ ...l, chargedAt: l.chargedAt.toISOString() })),
    payments: row.allocations.map((a) => ({ receiptNumber: a.payment.receiptNumber, method: a.payment.method, paidAt: a.payment.paidAt.toISOString(), amount: a.amount })),
    writeOffs: row.status === "CANCELLED" ? [] : row.writeOffs.map((w) => ({ amount: w.amount, reason: w.reason, note: w.note, writtenOffAt: w.writtenOffAt.toISOString() })),
    claimed,
    claims: row.claims.map((c) => ({
      id: c.id,
      number: c.number,
      status: c.status,
      payerName: c.payer.name,
      memberNumber: c.coverage.memberNumber,
      amount: c.amount,
      paid: c.lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.paid, 0), 0),
      refused: c.lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.refused, 0), 0),
    })),
    creditNote: row.creditNote ? { ...row.creditNote, issuedAt: row.creditNote.issuedAt.toISOString() } : null,
    discountOf: Object.fromEntries(row.lines.filter((l) => l.charge.discountOfId).map((l) => [l.chargeId, l.charge.discountOfId!])),
  };
}

async function load(tenantId: string, id: string, client: Tx | typeof db = db): Promise<InvoiceDTO> {
  const row = await client.invoice.findFirst({ where: { id, tenantId }, include: invoiceInclude });
  if (!row) throw new InvoiceNotFoundError(id);
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  return toDTO(row, tenant?.name ?? "", await getTenantTimezone(tenantId));
}

export async function getInvoice(tenantId: string, id: string): Promise<InvoiceDTO> {
  return load(tenantId, id);
}

export interface InvoiceListRow {
  id: string;
  number: string | null;
  status: string;
  total: number;
  paid: number;
  writtenOff: number;
  /** What the payers' claims settle of it. */
  claimed: number;
  /** Left to pay (nothing on a draft or a cancelled invoice). */
  due: number;
  patientId: string;
  patientName: string;
  issuedAt: string | null;
  createdAt: string;
}

export async function listInvoices(tenantId: string, rawQuery: unknown = {}) {
  const query = InvoiceListQuery.parse(rawQuery);
  const patients = query.patientId && query.payable ? await db.$transaction((tx) => payableBy(tx, tenantId, query.patientId!)) : null;
  const where: Prisma.InvoiceWhereInput = {
    tenantId,
    ...(patients ? { patientId: { in: patients } } : query.patientId ? { patientId: query.patientId } : {}),
    ...(query.status === "OPEN" ? { status: { in: ["ISSUED", "PART_PAID"] } } : query.status ? { status: query.status } : {}),
    ...(query.q ? { OR: [{ number: { contains: query.q, mode: "insensitive" } }, { patient: { fullName: { contains: query.q, mode: "insensitive" } } }] } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.invoice.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        number: true,
        status: true,
        total: true,
        issuedAt: true,
        createdAt: true,
        patientId: true,
        patient: { select: { fullName: true } },
        allocations: { select: { amount: true } },
        writeOffs: { where: { voidedAt: null }, select: { amount: true } },
        claims: claimsSettling,
      },
    }),
    db.invoice.count({ where }),
  ]);
  return {
    invoices: rows.map((r): InvoiceListRow => {
      const live = r.status !== "CANCELLED";
      const paid = live ? r.allocations.reduce((s, a) => s + a.amount, 0) : 0;
      const writtenOff = live ? r.writeOffs.reduce((s, w) => s + w.amount, 0) : 0;
      const claimed = live ? claimedOn(r.claims) : 0;
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        total: r.total,
        paid,
        writtenOff,
        claimed,
        due: live && r.status !== "DRAFT" ? Math.max(0, r.total - paid - writtenOff - claimed) : 0,
        patientId: r.patientId,
        patientName: r.patient.fullName,
        issuedAt: r.issuedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ── Drafts ───────────────────────────────────────────────────────────────────

/** A draft from the patient's unbilled charges (those given, or all of one branch's). */
export async function createDraft(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<InvoiceDTO> {
  const input = InvoiceDraftInput.parse(rawInput);
  const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true, language: true } });
  if (!patient) throw new TenantScopeError("patient", input.patientId);
  const id = await db.$transaction(async (tx) => {
    const billable = await billableCharges(tx, tenantId, patient.id);
    let chosen: BillableCharge[];
    if (input.chargeIds) {
      const byId = new Map(billable.map((c) => [c.id, c]));
      // A charge chosen brings its discounts along.
      const chosenIds = new Set(input.chargeIds);
      for (const c of billable) if (c.discountOfId && chosenIds.has(c.discountOfId) && !chosenIds.has(c.id)) input.chargeIds.push(c.id);
      const missing = input.chargeIds.filter((cid) => !byId.has(cid));
      if (missing.length) {
        throw new FinanceError(409, "not_billable", "some charges are billed already or are not the patient's", {
          message: "Some of those charges are on another invoice already.",
          chargeIds: missing,
        });
      }
      chosen = input.chargeIds.map((cid) => byId.get(cid)!);
      if (new Set(chosen.map((c) => c.clinicId)).size > 1) {
        throw new z.ZodError([{ code: "custom", path: ["chargeIds"], message: "One branch per invoice: these charges were done at different branches" }]);
      }
    } else {
      const branch = billable[0]?.clinicId;
      chosen = billable.filter((c) => c.clinicId === branch);
    }
    const sum = chosen.reduce((s, c) => s + c.amount, 0);
    if (!chosen.length || sum <= 0) {
      throw new FinanceError(409, "nothing_to_bill", "nothing to bill", { message: "There is nothing unbilled to put on an invoice." });
    }
    const invoice = await tx.invoice.create({
      data: {
        tenantId,
        clinicId: chosen[0]!.clinicId,
        patientId: patient.id,
        status: "DRAFT",
        language: input.language ?? (patient.language === "ar" ? "ar" : "en"),
        total: sum,
        note: input.note ?? null,
        createdById: actor.id ?? null,
        lines: { create: chosen.map((c, i) => ({ tenantId, chargeId: c.id, description: c.description, amount: c.amount, chargedAt: c.chargedAt, position: i + 1 })) },
      },
      select: { id: true },
    });
    // A covered patient's work at the contract's price.
    await applyContractDiscounts(tx, tenantId, invoice.id, actor.id ?? null, new Date());
    return invoice.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.draft", entity: "Invoice", entityId: id, after: { patientId: patient.id, lines: (input.chargeIds ?? []).length || undefined } });
  return load(tenantId, id);
}

async function lockDraft(tx: Tx, tenantId: string, id: string) {
  const invoice = await tx.invoice.findFirst({ where: { id, tenantId }, select: { id: true, status: true, patientId: true, clinicId: true } });
  if (!invoice) throw new InvoiceNotFoundError(id);
  return invoice;
}

/** Change a draft: its language, its note, or take lines off it. */
export async function updateDraft(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}): Promise<InvoiceDTO> {
  const input = InvoiceDraftUpdate.parse(rawInput);
  await db.$transaction(async (tx) => {
    const invoice = await lockDraft(tx, tenantId, id);
    if (invoice.status !== "DRAFT") throw invoiceState(invoice.status, "changed", "An issued invoice never changes: cancel it with a credit note and issue a new one.");
    if (input.removeChargeIds?.length) {
      // A discount stays with its charge: taking a charge off takes its discounts too, and a discount alone stays.
      const onDraft = await tx.invoiceLine.findMany({ where: { tenantId, invoiceId: id }, select: { chargeId: true, charge: { select: { discountOfId: true } } } });
      const discountOf = new Map(onDraft.filter((l) => l.charge.discountOfId).map((l) => [l.chargeId, l.charge.discountOfId!]));
      const removing = new Set(input.removeChargeIds);
      const alone = [...removing].filter((cid) => discountOf.has(cid) && !removing.has(discountOf.get(cid)!));
      if (alone.length) {
        throw new FinanceError(409, "discount_stays", "a discount is taken off with its charge", { message: "A discount stays with its charge: take the charge off to take its discount off too." });
      }
      for (const [discount, of] of discountOf) if (removing.has(of)) removing.add(discount);
      await tx.invoiceLine.deleteMany({ where: { tenantId, invoiceId: id, chargeId: { in: [...removing] } } });
    }
    const lines = await tx.invoiceLine.findMany({ where: { tenantId, invoiceId: id }, select: { amount: true } });
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    if (!lines.length || sum <= 0) {
      throw new FinanceError(409, "nothing_to_bill", "a draft keeps at least one line", { message: "An invoice needs something to bill: discard the draft instead." });
    }
    await tx.invoice.update({
      where: { id },
      data: { total: sum, ...(input.language ? { language: input.language } : {}), ...(input.note !== undefined ? { note: input.note } : {}) },
    });
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.update", entity: "Invoice", entityId: id, after: input });
  return load(tenantId, id);
}

/** Discard a draft: it had no number, and its charges go back to unbilled. */
export async function discardDraft(tenantId: string, id: string, actor: Actor = {}): Promise<void> {
  await db.$transaction(async (tx) => {
    const invoice = await lockDraft(tx, tenantId, id);
    if (invoice.status !== "DRAFT") throw invoiceState(invoice.status, "discarded", "An issued invoice is never deleted: cancel it with a credit note.");
    await tx.invoice.delete({ where: { id } });
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.discard", entity: "Invoice", entityId: id });
}

// ── Issuing and cancelling ───────────────────────────────────────────────────

/** Issue a draft: the branch's next number, today's date, and the patient's credit put towards it. */
export async function issueInvoice(tenantId: string, id: string, actor: Actor = {}): Promise<InvoiceDTO> {
  const now = new Date();
  const issued = await db.$transaction(async (tx) => {
    // Lock the draft, so two people issuing it at once get one number between them.
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({
      where: { id, tenantId },
      select: { id: true, status: true, patientId: true, clinicId: true, lines: { select: { chargeId: true, amount: true } } },
    });
    if (!invoice) throw new InvoiceNotFoundError(id);
    if (invoice.status !== "DRAFT") throw invoiceState(invoice.status, "issued", "This invoice is issued already.");
    const chargeIds = invoice.lines.map((l) => l.chargeId);
    const elsewhere = await tx.invoiceLine.findFirst({
      where: { tenantId, chargeId: { in: chargeIds }, invoiceId: { not: id }, invoice: { status: { in: [...ISSUED] } } },
      select: { invoice: { select: { number: true } } },
    });
    if (elsewhere) {
      throw new FinanceError(409, "already_invoiced", "a charge on this draft is on an issued invoice", {
        message: `A charge on this draft is on invoice ${elsewhere.invoice.number ?? ""} already: discard this draft.`,
      });
    }
    // The contract's discounts as the patient's covers stand today (a cover added or ended since the draft).
    await applyContractDiscounts(tx, tenantId, id, actor.id ?? null, now);
    const total = (await tx.invoiceLine.aggregate({ where: { tenantId, invoiceId: id }, _sum: { amount: true } }))._sum.amount ?? 0;
    if (total <= 0) throw new FinanceError(409, "nothing_to_bill", "nothing to bill", { message: "There is nothing to bill on this draft." });
    const { sequence, number } = await takeNumber(tx, tenantId, invoice.clinicId, "INVOICE");
    await tx.invoice.update({ where: { id }, data: { status: "ISSUED", sequence, number, total, issuedAt: now, issuedById: actor.id ?? null } });
    // The payers' shares first: the patient's credit goes towards what is left.
    const claims = await claimInvoiceTx(tx, tenantId, id, actor.id ?? null, now);
    await allocateCredit(tx, tenantId, invoice.patientId, actor.id ?? null);
    await refreshInvoiceStatus(tx, tenantId, id);
    await tx.timelineEvent.create({
      data: { tenantId, patientId: invoice.patientId, kind: "PAYMENT", title: `Invoice ${number} issued — ${total.toLocaleString("en-US")} EGP`, refId: id, occurredAt: now },
    });
    return { number, total, claims };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.issue", entity: "Invoice", entityId: id, after: { number: issued.number, total: issued.total } });
  for (const c of issued.claims) {
    await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "claim.create", entity: "Claim", entityId: c.id, after: { number: c.number, payer: c.payerName, amount: c.amount, invoice: issued.number } });
  }
  return load(tenantId, id);
}

/**
 * Cancel an issued invoice with a reason: a credit note for its total, in the
 * branch's own credit-note sequence; what was allocated to it goes back to
 * the patient's credit (and on to their other open invoices), its claims are
 * cancelled (not once a payer has paid any of them), and its charges can be
 * billed again.
 */
export async function cancelInvoice(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}): Promise<InvoiceDTO> {
  const input = InvoiceCancelInput.parse(rawInput);
  const now = new Date();
  const cancelled = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({ where: { id, tenantId }, select: { id: true, status: true, patientId: true, clinicId: true, total: true, number: true } });
    if (!invoice) throw new InvoiceNotFoundError(id);
    if (invoice.status === "DRAFT") throw invoiceState(invoice.status, "cancelled", "A draft has no number: discard it instead.");
    if (invoice.status === "CANCELLED") throw invoiceState(invoice.status, "cancelled again", "This invoice is cancelled already.");
    // Its claims go with it, while the payer has paid nothing of them.
    const claims = await cancelInvoiceClaimsTx(tx, tenantId, id, input.reason, now);
    const { sequence, number } = await takeNumber(tx, tenantId, invoice.clinicId, "CREDIT_NOTE");
    await tx.creditNote.create({
      data: { tenantId, clinicId: invoice.clinicId, invoiceId: id, sequence, number, amount: invoice.total, reason: input.reason, issuedAt: now, issuedById: actor.id ?? null },
    });
    const allocations = await tx.paymentAllocation.findMany({ where: { tenantId, invoiceId: id }, select: { amount: true, payment: { select: { patientId: true } } } });
    const released = allocations.reduce((s, a) => s + a.amount, 0);
    await tx.paymentAllocation.deleteMany({ where: { tenantId, invoiceId: id } });
    // What was written off on it goes with it: its charges are billable again, in full.
    await tx.writeOff.updateMany({ where: { tenantId, invoiceId: id, voidedAt: null }, data: { voidedAt: now } });
    await tx.invoice.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id ?? null, cancelReason: input.reason } });
    // What it had been paid goes back to whoever paid it (the patient, or the head of their family) and on to open invoices.
    await allocateFor(tx, tenantId, [invoice.patientId, ...allocations.map((a) => a.payment.patientId)], actor.id ?? null);
    await tx.timelineEvent.create({
      data: { tenantId, patientId: invoice.patientId, kind: "PAYMENT", title: `Invoice ${invoice.number} cancelled by credit note ${number}`, body: input.reason, refId: id, occurredAt: now },
    });
    return { creditNote: number, amount: invoice.total, released, claims };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.cancel", entity: "Invoice", entityId: id, after: { ...cancelled, reason: input.reason } });
  return load(tenantId, id);
}

// ── The patient's copy ───────────────────────────────────────────────────────

const INVOICE_PURPOSE = "invoice" as const;

export function invoiceLink(token: string): string {
  return `${publicBaseUrl()}/i/${token}`;
}

/** The message that carries the patient's copy, in the invoice's language. */
export function invoiceMessage(invoice: InvoiceDTO, link: string): string {
  const first = invoice.patient.fullName.split(/\s+/)[0] ?? invoice.patient.fullName;
  const n = (v: number) => v.toLocaleString("en-US");
  if (invoice.language === "ar") {
    return `مرحبًا ${first}، فاتورتك رقم ${invoice.number} من ${invoice.tenantName} بقيمة ${n(invoice.total)} جنيه: ${link}${invoice.due > 0 ? `\nالمدفوع ${n(invoice.paid)} جنيه، والمتبقي ${n(invoice.due)} جنيه.` : "\nمدفوعة بالكامل، شكرًا لك."}`;
  }
  return `Hi ${first}, your invoice ${invoice.number} from ${invoice.tenantName} for ${n(invoice.total)} EGP: ${link}${invoice.due > 0 ? `\nPaid ${n(invoice.paid)} EGP, ${n(invoice.due)} EGP to pay.` : "\nPaid in full, thank you."}`;
}

/**
 * Send the patient their copy on WhatsApp: a fresh link (the last one sent is
 * the one that works) and the totals, in the invoice's language.
 */
export async function sendInvoice(tenantId: string, id: string, actor: Actor = {}) {
  const invoice = await load(tenantId, id);
  if (invoice.status === "DRAFT" || invoice.status === "CANCELLED") {
    throw invoiceState(invoice.status, "sent", invoice.status === "DRAFT" ? "Issue the invoice before sending it." : "A cancelled invoice is not sent.");
  }
  const token = generateToken();
  const link = invoiceLink(token);
  await db.invoice.update({ where: { id }, data: { shareTokenHash: hashToken(token, INVOICE_PURPOSE), sentAt: new Date() } });
  const sent = await sendPatientMessage(tenantId, {
    patientId: invoice.patient.id,
    body: invoiceMessage(invoice, link),
    templateKey: "invoice:send",
    authorId: actor.id ?? null,
    author: "HUMAN",
    meta: { invoiceId: id, number: invoice.number },
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.send", entity: "Invoice", entityId: id, after: { number: invoice.number, delivery: sent.delivery } });
  return { link, delivery: sent.delivery, conversationId: sent.conversationId };
}

/** The invoice behind a patient's link, or null. Public: the token is the only key. */
export async function invoiceByToken(token: string): Promise<InvoiceDTO | null> {
  if (!looksLikeToken(token)) return null;
  const found = await systemDb.invoice.findUnique({ where: { shareTokenHash: hashToken(token, INVOICE_PURPOSE) }, select: { id: true, tenantId: true, status: true } });
  if (!found || found.status === "DRAFT") return null;
  return withTenant(found.tenantId, () => load(found.tenantId, found.id));
}

/** "28 Oct 2026" / "٢٨ أكتوبر ٢٠٢٦" with Latin digits, on the clinic clock. */
export function invoiceDate(iso: string, timezone: string, language: InvoiceLanguage): string {
  return formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "long", year: "numeric" }, language === "ar" ? "ar-EG-u-nu-latn" : "en-GB");
}
