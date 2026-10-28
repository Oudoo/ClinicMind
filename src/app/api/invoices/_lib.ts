import { can, RbacError } from "@/lib/auth/rbac";
import type { UserRole } from "@prisma/client";

/** Invoices are read by the front desk (`payments:write`) and the owner (`finance:read`). */
export function assertCanReadInvoices(role: UserRole): void {
  if (!can(role, "payments:write") && !can(role, "finance:read")) throw new RbacError(`Role ${role} lacks permission payments:write`);
}
