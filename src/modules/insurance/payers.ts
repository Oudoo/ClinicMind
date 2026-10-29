import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { MAX_AMOUNT } from "@/modules/finance/constants";
import { FinanceError } from "@/modules/finance/errors";
import { AGE_BUCKETS, ageBucketOf, COVER_CATEGORIES, MAX_CONTRACT_DISCOUNT, PAYER_KIND_LABELS, PAYER_KINDS, type AgeBucketKey, type PayerKindValue } from "./constants";
import { toTerms } from "./claims";
import { contractOn, within } from "./terms";

/**
 * Insurers and companies: who pays for covered patients, on what terms, and
 * what each owes. A payer has contracts over spans of days that never
 * overlap (a new one ends the open one the day before it starts); a
 * contract's terms are its discount off the price list, the patient's share,
 * the yearly limit per member, the amount above which its approval is needed
 * first, and what it covers by category of the price list or by item. Claims
 * keep the amounts worked out under the contract of their day, so changing a
 * contract changes only the claims to come. What a payer owes is its claims'
 * shares less what it paid and refused, by how long ago they were claimed.
 * Payers are never deleted: archived.
 */

type Tx = Prisma.TransactionClient;
export type InsuranceActor = { id?: string | null; email?: string | null; ip?: string | null; role?: UserRole | null };

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zPercent = z.number().int("A whole percent").min(0, "0 to 100").max(100, "0 to 100");
const zEmail = zOptionalText(160).refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Not an e-mail address");

const asDate = (key: string) => new Date(`${key}T00:00:00.000Z`);
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const addDaysKey = (key: string, days: number) => keyOf(new Date(asDate(key).getTime() + days * 86_400_000));

export const PayerInput = z.object({
  name: zText(120).min(2, "The payer's name"),
  kind: z.enum(PAYER_KINDS),
  contactName: zOptionalText(120),
  phone: zOptionalText(40),
  email: zEmail,
  address: zOptionalText(300),
  paymentDays: z.number().int().min(0, "0 to 365 days").max(365, "0 to 365 days").default(60),
  notes: zOptionalText(1000),
  /** No longer works with the clinic: kept with its claims, offered for new covers no more (edit only). */
  archived: z.boolean().optional(),
});

export const ContractRuleInput = z
  .object({
    category: z.enum(COVER_CATEGORIES).optional(),
    priceItemId: zOptionalText(64),
    covered: z.boolean(),
    copayPct: zPercent.optional(),
    needsApproval: z.boolean().default(false),
  })
  .refine((r) => Boolean(r.category) !== Boolean(r.priceItemId), { path: ["category"], message: "A category or an item of the price list" });

export const ContractInput = z
  .object({
    reference: zOptionalText(80),
    validFrom: zDayKey,
    validTo: zDayKey.optional(),
    discountPct: z.number().int("A whole percent").min(0, `0 to ${MAX_CONTRACT_DISCOUNT}`).max(MAX_CONTRACT_DISCOUNT, `0 to ${MAX_CONTRACT_DISCOUNT}`).default(0),
    copayPct: zPercent.default(0),
    annualLimit: z.number().int("Whole EGP").positive("More than zero").max(MAX_AMOUNT, "Too large").optional(),
    approvalAbove: z.number().int("Whole EGP").min(0, "Zero or more").max(MAX_AMOUNT, "Too large").optional(),
    coveredByDefault: z.boolean().default(true),
    note: zOptionalText(1000),
    rules: z.array(ContractRuleInput).max(60, "At most 60 rules").default([]),
  })
  .superRefine((v, ctx) => {
    if (v.validTo && v.validTo < v.validFrom) ctx.addIssue({ code: "custom", path: ["validTo"], message: "Not before its first day" });
    const seen = new Set<string>();
    v.rules.forEach((r, i) => {
      const key = r.category ? `c:${r.category}` : `i:${r.priceItemId}`;
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["rules", i], message: "Said twice" });
      seen.add(key);
    });
  });

export interface ContractDTO {
  id: string;
  reference: string | null;
  validFrom: string;
  validTo: string | null;
  discountPct: number;
  copayPct: number;
  annualLimit: number | null;
  approvalAbove: number | null;
  coveredByDefault: boolean;
  note: string | null;
  rules: { category: string | null; priceItemId: string | null; priceItemName: string | null; covered: boolean; copayPct: number | null; needsApproval: boolean }[];
  /** In force today. */
  current: boolean;
}

export interface PayerDTO {
  id: string;
  name: string;
  kind: PayerKindValue;
  kindLabel: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  paymentDays: number;
  notes: string | null;
  archived: boolean;
  /** Patients covered today. */
  members: number;
  /** Owed on its claims now, and how much of it is not sent yet. */
  owed: number;
  toSend: number;
  /** The contract in force today. */
  contract: ContractDTO | null;
}

const contractInclude = {
  rules: { orderBy: [{ category: "asc" as const }, { id: "asc" as const }], include: { priceItem: { select: { name: true } } } },
} satisfies Prisma.PayerContractInclude;
type ContractRow = Prisma.PayerContractGetPayload<{ include: typeof contractInclude }>;

function contractDTO(c: ContractRow, today: string): ContractDTO {
  return {
    id: c.id,
    reference: c.reference,
    validFrom: keyOf(c.validFrom),
    validTo: c.validTo ? keyOf(c.validTo) : null,
    discountPct: c.discountPct,
    copayPct: c.copayPct,
    annualLimit: c.annualLimit,
    approvalAbove: c.approvalAbove,
    coveredByDefault: c.coveredByDefault,
    note: c.note,
    rules: c.rules.map((r) => ({ category: r.category, priceItemId: r.priceItemId, priceItemName: r.priceItem?.name ?? null, covered: r.covered, copayPct: r.copayPct, needsApproval: r.needsApproval })),
    current: within({ validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null }, today),
  };
}

/** What each payer's live claims are owed: their lines' shares less what was paid and refused. */
async function owedClaims(client: Tx | typeof db, tenantId: string, payerIds?: string[], clinicId?: string | null) {
  const claims = await client.claim.findMany({
    where: { tenantId, status: { in: ["OPEN", "SENT"] }, ...(payerIds ? { payerId: { in: payerIds } } : {}), ...(clinicId ? { clinicId } : {}) },
    select: {
      id: true,
      payerId: true,
      status: true,
      claimedAt: true,
      batch: { select: { sentAt: true } },
      lines: { select: { payerShare: true, answers: { where: { voidedAt: null }, select: { paid: true, refused: true } } } },
    },
  });
  return claims.map((c) => ({ ...c, owed: c.lines.reduce((s, l) => s + l.payerShare - l.answers.reduce((t, a) => t + a.paid + a.refused, 0), 0) }));
}

async function toPayerDTOs(tenantId: string, rows: Prisma.PayerGetPayload<{ include: { contracts: { include: typeof contractInclude } } }>[]): Promise<PayerDTO[]> {
  const timezone = await getTenantTimezone(tenantId);
  const today = dateKeyInTz(new Date(), timezone);
  const ids = rows.map((r) => r.id);
  const [claims, covers] = await Promise.all([
    owedClaims(db, tenantId, ids),
    db.coverage.findMany({ where: { tenantId, payerId: { in: ids } }, select: { payerId: true, validFrom: true, validTo: true } }),
  ]);
  return rows.map((p) => {
    const ours = claims.filter((c) => c.payerId === p.id);
    const current = contractOn(
      p.contracts.map((c) => ({ ...c, validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null })),
      today,
    );
    const contract = current ? p.contracts.find((c) => c.id === current.id)! : null;
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      kindLabel: PAYER_KIND_LABELS[p.kind],
      contactName: p.contactName,
      phone: p.phone,
      email: p.email,
      address: p.address,
      paymentDays: p.paymentDays,
      notes: p.notes,
      archived: Boolean(p.archivedAt),
      members: covers.filter((c) => c.payerId === p.id && within({ validFrom: keyOf(c.validFrom), validTo: c.validTo ? keyOf(c.validTo) : null }, today)).length,
      owed: ours.reduce((s, c) => s + c.owed, 0),
      toSend: ours.filter((c) => c.status === "OPEN").reduce((s, c) => s + c.owed, 0),
      contract: contract ? contractDTO(contract, today) : null,
    };
  });
}

export async function listPayers(tenantId: string, opts: { archived?: boolean } = {}): Promise<PayerDTO[]> {
  const rows = await db.payer.findMany({
    where: { tenantId, ...(opts.archived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    include: { contracts: { orderBy: { validFrom: "desc" }, include: contractInclude } },
  });
  return toPayerDTOs(tenantId, rows);
}

export interface PayerDetail extends PayerDTO {
  contracts: ContractDTO[];
}

export async function getPayer(tenantId: string, id: string): Promise<PayerDetail> {
  const row = await db.payer.findFirst({ where: { id, tenantId }, include: { contracts: { orderBy: { validFrom: "desc" }, include: contractInclude } } });
  if (!row) throw new TenantScopeError("payer", id);
  const [dto] = await toPayerDTOs(tenantId, [row]);
  const today = dateKeyInTz(new Date(), await getTenantTimezone(tenantId));
  return { ...dto!, contracts: row.contracts.map((c) => contractDTO(c, today)) };
}

async function assertNameFree(tx: Tx, tenantId: string, name: string, exceptId?: string) {
  const taken = await tx.payer.findFirst({ where: { tenantId, name: { equals: name.replace(/\s+/g, " "), mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (taken) throw new FinanceError(409, "duplicate", "a payer by that name exists", { message: "There is a payer by that name already." });
}

export async function createPayer(tenantId: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PayerDetail> {
  const input = PayerInput.parse(rawInput);
  const id = await db.$transaction(async (tx) => {
    await assertNameFree(tx, tenantId, input.name);
    const payer = await tx.payer.create({
      data: {
        tenantId,
        name: input.name.replace(/\s+/g, " "),
        kind: input.kind,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        paymentDays: input.paymentDays,
        notes: input.notes ?? null,
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    return payer.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "payer.create", entity: "Payer", entityId: id, after: { name: input.name, kind: input.kind, paymentDays: input.paymentDays } });
  return getPayer(tenantId, id);
}

export async function updatePayer(tenantId: string, id: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PayerDetail> {
  const input = PayerInput.parse(rawInput);
  const before = await db.$transaction(async (tx) => {
    const payer = await tx.payer.findFirst({ where: { id, tenantId } });
    if (!payer) throw new TenantScopeError("payer", id);
    await assertNameFree(tx, tenantId, input.name, id);
    await tx.payer.update({
      where: { id },
      data: {
        name: input.name.replace(/\s+/g, " "),
        kind: input.kind,
        contactName: input.contactName ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        paymentDays: input.paymentDays,
        notes: input.notes ?? null,
        ...(input.archived === undefined ? {} : { archivedAt: input.archived ? (payer.archivedAt ?? new Date()) : null }),
      },
    });
    return payer;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "payer.update",
    entity: "Payer",
    entityId: id,
    before: { name: before.name, kind: before.kind, paymentDays: before.paymentDays, archived: Boolean(before.archivedAt) },
    after: { name: input.name, kind: input.kind, paymentDays: input.paymentDays, archived: input.archived ?? Boolean(before.archivedAt) },
  });
  return getPayer(tenantId, id);
}

// ── Contracts ────────────────────────────────────────────────────────────────

const overlaps = (a: { validFrom: string; validTo: string | null }, b: { validFrom: string; validTo: string | null }) =>
  (a.validTo === null || b.validFrom <= a.validTo) && (b.validTo === null || a.validFrom <= b.validTo);

/** The rules as rows, their items checked to be the clinic's. */
async function ruleRows(tx: Tx, tenantId: string, contractId: string, rules: z.infer<typeof ContractRuleInput>[]) {
  const itemIds = rules.flatMap((r) => (r.priceItemId ? [r.priceItemId] : []));
  if (itemIds.length) {
    const found = await tx.priceItem.findMany({ where: { tenantId, id: { in: itemIds } }, select: { id: true } });
    const missing = itemIds.find((i) => !found.some((f) => f.id === i));
    if (missing) throw new TenantScopeError("price_item", missing);
  }
  return rules.map((r) => ({ tenantId, contractId, category: r.category ?? null, priceItemId: r.priceItemId ?? null, covered: r.covered, copayPct: r.copayPct ?? null, needsApproval: r.needsApproval }));
}

/**
 * The payer's other contracts must not overlap this one's days; one left open
 * that started before this one ends the day before it starts. Returns the
 * contracts so ended, and their last day.
 */
async function fitContract(tx: Tx, tenantId: string, payerId: string, span: { validFrom: string; validTo: string | null }, exceptId: string | null, actor: InsuranceActor): Promise<{ id: string; validTo: string }[]> {
  await tx.$queryRaw`SELECT id FROM "payers" WHERE id = ${payerId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const others = (await tx.payerContract.findMany({ where: { tenantId, payerId, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, validFrom: true, validTo: true } })).map((c) => ({
    id: c.id,
    validFrom: keyOf(c.validFrom),
    validTo: c.validTo ? keyOf(c.validTo) : null,
  }));
  const ended: { id: string; validTo: string }[] = [];
  for (const o of others) {
    if (!overlaps(o, span)) continue;
    if (o.validTo === null && o.validFrom < span.validFrom) {
      const end = addDaysKey(span.validFrom, -1);
      await tx.payerContract.update({ where: { id: o.id }, data: { validTo: asDate(end), updatedById: actor.id ?? null } });
      ended.push({ id: o.id, validTo: end });
      continue;
    }
    throw new FinanceError(409, "overlap", "the payer has a contract on those days", {
      message: `Another contract with this payer covers ${o.validFrom}${o.validTo ? ` to ${o.validTo}` : " onwards"}: contracts do not overlap.`,
    });
  }
  return ended;
}

const auditEnded = (tenantId: string, actor: InsuranceActor, ended: { id: string; validTo: string }[], from: string) =>
  Promise.all(ended.map((e) => audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "payer.contract_end", entity: "PayerContract", entityId: e.id, after: { validTo: e.validTo, replacedFrom: from } })));

export async function createContract(tenantId: string, payerId: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PayerDetail> {
  const input = ContractInput.parse(rawInput);
  const { id, ended } = await db.$transaction(async (tx) => {
    const payer = await tx.payer.findFirst({ where: { id: payerId, tenantId }, select: { id: true } });
    if (!payer) throw new TenantScopeError("payer", payerId);
    const ended = await fitContract(tx, tenantId, payerId, { validFrom: input.validFrom, validTo: input.validTo ?? null }, null, actor);
    const contract = await tx.payerContract.create({
      data: {
        tenantId,
        payerId,
        reference: input.reference ?? null,
        validFrom: asDate(input.validFrom),
        validTo: input.validTo ? asDate(input.validTo) : null,
        discountPct: input.discountPct,
        copayPct: input.copayPct,
        annualLimit: input.annualLimit ?? null,
        approvalAbove: input.approvalAbove ?? null,
        coveredByDefault: input.coveredByDefault,
        note: input.note ?? null,
        createdById: actor.id ?? null,
      },
      select: { id: true },
    });
    const rules = await ruleRows(tx, tenantId, contract.id, input.rules);
    if (rules.length) await tx.payerRule.createMany({ data: rules });
    return { id: contract.id, ended };
  });
  await auditEnded(tenantId, actor, ended, input.validFrom);
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "payer.contract_create", entity: "PayerContract", entityId: id, after: { payerId, ...input } });
  return getPayer(tenantId, payerId);
}

export async function updateContract(tenantId: string, contractId: string, rawInput: unknown, actor: InsuranceActor = {}): Promise<PayerDetail> {
  const input = ContractInput.parse(rawInput);
  const { before, ended } = await db.$transaction(async (tx) => {
    const contract = await tx.payerContract.findFirst({ where: { id: contractId, tenantId }, include: { rules: true } });
    if (!contract) throw new TenantScopeError("payer_contract", contractId);
    const ended = await fitContract(tx, tenantId, contract.payerId, { validFrom: input.validFrom, validTo: input.validTo ?? null }, contractId, actor);
    await tx.payerContract.update({
      where: { id: contractId },
      data: {
        reference: input.reference ?? null,
        validFrom: asDate(input.validFrom),
        validTo: input.validTo ? asDate(input.validTo) : null,
        discountPct: input.discountPct,
        copayPct: input.copayPct,
        annualLimit: input.annualLimit ?? null,
        approvalAbove: input.approvalAbove ?? null,
        coveredByDefault: input.coveredByDefault,
        note: input.note ?? null,
        updatedById: actor.id ?? null,
      },
    });
    await tx.payerRule.deleteMany({ where: { tenantId, contractId } });
    const rules = await ruleRows(tx, tenantId, contractId, input.rules);
    if (rules.length) await tx.payerRule.createMany({ data: rules });
    return { before: contract, ended };
  });
  await auditEnded(tenantId, actor, ended, input.validFrom);
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "payer.contract_update",
    entity: "PayerContract",
    entityId: contractId,
    before: { ...toTerms(before), rules: before.rules.map((r) => ({ category: r.category, priceItemId: r.priceItemId, covered: r.covered, copayPct: r.copayPct, needsApproval: r.needsApproval })) },
    after: input,
  });
  return getPayer(tenantId, before.payerId);
}

// ── What payers owe ──────────────────────────────────────────────────────────

export interface AgingRow {
  payerId: string;
  payerName: string;
  kind: PayerKindValue;
  /** Owed on claims not sent yet (in the buckets too). */
  notSent: number;
  /** Owed by how long ago the work was claimed. */
  buckets: Record<AgeBucketKey, number>;
  total: number;
  /** Owed on batches sent longer ago than the payer's days to pay. */
  overdue: number;
  claims: number;
  oldestClaimedAt: string | null;
}

export interface AgingReport {
  rows: AgingRow[];
  totals: Omit<AgingRow, "payerId" | "payerName" | "kind" | "oldestClaimedAt">;
}

const zeroBuckets = (): Record<AgeBucketKey, number> => Object.fromEntries(AGE_BUCKETS.map((b) => [b.key, 0])) as Record<AgeBucketKey, number>;

/** What every payer owes now, by how long ago its claims were made, and what is past its days to pay. */
export async function owedByPayer(tenantId: string, now: Date = new Date(), opts: { clinicId?: string | null } = {}): Promise<AgingReport> {
  const [payers, claims] = await Promise.all([db.payer.findMany({ where: { tenantId }, select: { id: true, name: true, kind: true, paymentDays: true } }), owedClaims(db, tenantId, undefined, opts.clinicId)]);
  const rows = new Map<string, AgingRow>();
  const totals: AgingReport["totals"] = { notSent: 0, buckets: zeroBuckets(), total: 0, overdue: 0, claims: 0 };
  for (const c of claims) {
    if (c.owed <= 0) continue;
    const payer = payers.find((p) => p.id === c.payerId);
    if (!payer) continue;
    const row = rows.get(payer.id) ?? { payerId: payer.id, payerName: payer.name, kind: payer.kind, notSent: 0, buckets: zeroBuckets(), total: 0, overdue: 0, claims: 0, oldestClaimedAt: null };
    const bucket = ageBucketOf(Math.floor((now.getTime() - c.claimedAt.getTime()) / 86_400_000));
    const overdue = c.batch !== null && now.getTime() - c.batch.sentAt.getTime() > payer.paymentDays * 86_400_000;
    for (const t of [row, totals]) {
      t.buckets[bucket] += c.owed;
      t.total += c.owed;
      t.claims += 1;
      if (c.status === "OPEN") t.notSent += c.owed;
      if (overdue) t.overdue += c.owed;
    }
    if (!row.oldestClaimedAt || c.claimedAt.toISOString() < row.oldestClaimedAt) row.oldestClaimedAt = c.claimedAt.toISOString();
    rows.set(payer.id, row);
  }
  return { rows: [...rows.values()].sort((a, b) => b.total - a.total || a.payerName.localeCompare(b.payerName)), totals };
}

export interface InsuranceKpis {
  owed: number;
  overdue: number;
  toSend: { claims: number; amount: number };
  approvalsWaiting: number;
}

export async function insuranceKpis(tenantId: string, now: Date = new Date()): Promise<InsuranceKpis> {
  const [aging, open, waiting] = await Promise.all([
    owedByPayer(tenantId, now),
    owedClaims(db, tenantId).then((cs) => cs.filter((c) => c.status === "OPEN")),
    db.preApproval.count({ where: { tenantId, status: "REQUESTED" } }),
  ]);
  return { owed: aging.totals.total, overdue: aging.totals.overdue, toSend: { claims: open.length, amount: open.reduce((s, c) => s + c.owed, 0) }, approvalsWaiting: waiting };
}
