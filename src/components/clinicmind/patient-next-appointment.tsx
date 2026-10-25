import type { UserRole } from "@prisma/client";

/**
 * The patient's next appointment as one button, with a quick way to book the next visit.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientNextAppointment(_props: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  return null;
}
