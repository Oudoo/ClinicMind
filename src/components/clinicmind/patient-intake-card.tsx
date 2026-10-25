import type { UserRole } from "@prisma/client";

/**
 * Onboarding: send this patient a pre-filled intake link, see submissions.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientIntakeCard(_props: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  return null;
}
