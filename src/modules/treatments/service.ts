import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { TenantScopeError } from "@/lib/tenant-scope";

/**
 * The treatment catalogue: what leads enquire about, what procedures are
 * signed as, what a concierge protocol belongs to and how the reports group
 * revenue. Every tenant starts with the clinic's standard list; owners edit
 * prices and add treatments later. Money is whole EGP.
 */
type Client = Prisma.TransactionClient;

export interface TreatmentSeed {
  key: string;
  name: string;
  category: "hair" | "skin" | "laser" | "injectables" | "general";
  consultationFee: number;
  priceFrom: number;
  priceTo: number;
  depositAmount: number;
}

export const DEFAULT_TREATMENTS: readonly TreatmentSeed[] = [
  { key: "hair-transplant", name: "Hair transplant", category: "hair", consultationFee: 500, priceFrom: 45_000, priceTo: 90_000, depositAmount: 5_000 },
  { key: "prp-hair", name: "Hair loss / PRP", category: "hair", consultationFee: 600, priceFrom: 7_500, priceTo: 9_000, depositAmount: 500 },
  { key: "acne", name: "Acne treatment", category: "skin", consultationFee: 600, priceFrom: 1_500, priceTo: 2_200, depositAmount: 0 },
  { key: "pigmentation", name: "Pigmentation / melasma", category: "skin", consultationFee: 600, priceFrom: 3_000, priceTo: 3_500, depositAmount: 500 },
  { key: "laser-hair-removal", name: "Laser hair removal", category: "laser", consultationFee: 0, priceFrom: 1_200, priceTo: 7_200, depositAmount: 0 },
  { key: "botox-fillers", name: "Botox & fillers", category: "injectables", consultationFee: 600, priceFrom: 2_500, priceTo: 12_000, depositAmount: 500 },
  { key: "general-dermatology", name: "General dermatology", category: "general", consultationFee: 600, priceFrom: 800, priceTo: 2_000, depositAmount: 0 },
];

/** Hair transplant is the treatment the spec singles out (concierge week 12, enquiries by source). */
export const HAIR_TRANSPLANT_KEY = "hair-transplant";

export async function ensureDefaultTreatments(tenantId: string, client: Client = db): Promise<void> {
  let order = 0;
  for (const t of DEFAULT_TREATMENTS) {
    await client.treatment.upsert({
      where: { tenantId_key: { tenantId, key: t.key } },
      create: { tenantId, ...t, sortOrder: order },
      update: {},
    });
    order += 10;
  }
}

/** Active treatments in display order; a tenant without any gets the defaults first. */
export async function listTreatments(tenantId: string, opts: { includeInactive?: boolean } = {}, client: Client = db) {
  const where = { tenantId, ...(opts.includeInactive ? {} : { active: true }) };
  let rows = await client.treatment.findMany({ where, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  if (!rows.length && !opts.includeInactive) {
    const any = await client.treatment.count({ where: { tenantId } });
    if (!any) {
      await ensureDefaultTreatments(tenantId, client);
      rows = await client.treatment.findMany({ where, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    }
  }
  return rows;
}

export type TreatmentRow = Awaited<ReturnType<typeof listTreatments>>[number];

export async function getTreatmentByKey(tenantId: string, key: string, client: Client = db) {
  return client.treatment.findUnique({ where: { tenantId_key: { tenantId, key } } });
}

/** The treatment must exist and belong to `tenantId` (SEC-4); 404 otherwise. */
export async function requireTenantTreatment(tenantId: string, treatmentId: string, client: Client = db) {
  const row = await client.treatment.findFirst({ where: { id: treatmentId, tenantId }, select: { id: true, key: true, name: true } });
  if (!row) throw new TenantScopeError("treatment", treatmentId);
  return row;
}

/** `key → name` for labels in reports and pickers. */
export async function treatmentNames(tenantId: string, client: Client = db): Promise<Map<string, string>> {
  const rows = await client.treatment.findMany({ where: { tenantId }, select: { key: true, name: true } });
  return new Map(rows.map((r) => [r.key, r.name]));
}
