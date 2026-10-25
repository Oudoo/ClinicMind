import type { UserRole } from "@prisma/client";

/**
 * The big upcoming-appointment button on the overview: the next appointment (the doctor's own, or the clinic's), countdown, one-tap actions.
 * Rendered by src/app/dashboard/page.tsx. Server component: fetch what it needs itself.
 */
export async function NextAppointmentHero(_props: { tenantId: string; userId: string | null; role: UserRole;  }) {
  return null;
}
