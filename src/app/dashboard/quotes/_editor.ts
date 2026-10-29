import type { UserRole } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { listPriceList } from "@/modules/finance/prices";
import { discountLimitOf } from "@/modules/finance/discounts";
import { listReportDoctors } from "@/modules/reporting/service";
import { toPriceOptions } from "@/components/clinicmind/finance-shared";

/** What the plan editor offers: the branches, the doctors, today's price list for a branch and the role's discount limit. */
export async function editorOptions(tenantId: string, role: UserRole, clinicId?: string) {
  const clinics = await db.clinic.findMany({ where: { tenantId, ...notDeleted }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } });
  const branch = clinicId && clinics.some((c) => c.id === clinicId) ? clinicId : (clinics[0]?.id ?? "");
  const [doctors, prices, discountLimit] = await Promise.all([listReportDoctors(tenantId), listPriceList(tenantId, branch ? { clinicId: branch } : {}), discountLimitOf(tenantId, role)]);
  return { clinics, branch, doctors, priceItems: toPriceOptions(prices.items), discountLimit, timezone: prices.timezone };
}
