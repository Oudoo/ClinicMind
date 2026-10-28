import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { getNextAppointment } from "@/modules/appointments/service";
import { nextWithBalances } from "@/modules/finance/ledger";
import { NextAppointmentCard } from "./appointment-next-card";

/**
 * The big upcoming-appointment button on the overview: a doctor's (or a
 * booked owner's) own next live appointment, otherwise the clinic's, with the
 * countdown, one-tap state actions and the rest of today's queue. Rendered by
 * src/app/dashboard/page.tsx. Server component: fetches the first answer and
 * hands it to the live client card, which refreshes itself every 30 seconds.
 */
export async function NextAppointmentHero({ tenantId, userId, role }: { tenantId: string; userId: string | null; role: UserRole }) {
  if (!can(role, "appointments:read")) return null;
  const initial = await nextWithBalances(tenantId, role, await getNextAppointment(tenantId, { userId, role, scope: "auto" }));
  return (
    <NextAppointmentCard
      variant="hero"
      initial={initial}
      timezone={initial.timezone}
      canWrite={can(role, "appointments:write")}
      canManage={can(role, "users:manage")}
      userId={userId}
    />
  );
}
