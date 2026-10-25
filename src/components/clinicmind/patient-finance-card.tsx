import type { UserRole } from "@prisma/client";

/**
 * Procedures and payments for this patient: signed procedures, deposits, balance, record a payment.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientFinanceCard(_props: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  return null;
}
