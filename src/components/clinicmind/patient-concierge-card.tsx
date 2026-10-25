import type { UserRole } from "@prisma/client";

/**
 * Concierge: the running enrolment, next check-in, last answers, escalations.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientConciergeCard(_props: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  return null;
}
