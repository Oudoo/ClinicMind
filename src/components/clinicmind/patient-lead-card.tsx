import type { UserRole } from "@prisma/client";

/**
 * CRM: the lead this patient came from, source, campaign, objections.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientLeadCard(_props: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  return null;
}
