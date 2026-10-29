import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { getNextAppointment } from "@/modules/appointments/service";
import { nextWithBalances } from "@/modules/finance/ledger";
import { nextWithRecalls } from "@/modules/recalls/service";
import { NextAppointmentCard } from "./appointment-next-card";

/**
 * The patient's next appointment as one prominent button with the countdown
 * and the same one-tap actions as the overview, plus "Book the next visit"
 * and "Reschedule"; a big "Book an appointment" when nothing is booked.
 * Rendered by the patient page. Server component: fetches the first answer
 * and hands it to the live client card.
 */
export async function PatientNextAppointment({
  tenantId,
  userId,
  role,
  patientId,
  canWrite,
}: {
  tenantId: string;
  userId: string | null;
  role: UserRole;
  patientId: string;
  canWrite: boolean;
}) {
  if (!can(role, "appointments:read")) return null;
  const [initial, patient] = await Promise.all([
    getNextAppointment(tenantId, { userId, role, patientId })
      .then((next) => nextWithBalances(tenantId, role, next))
      .then((next) => nextWithRecalls(tenantId, role, next)),
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { fullName: true } }),
  ]);
  if (!patient) return null;
  return (
    <NextAppointmentCard
      variant="patient"
      initial={initial}
      timezone={initial.timezone}
      patientId={patientId}
      patientName={patient.fullName}
      canWrite={canWrite && can(role, "appointments:write")}
      canManage={can(role, "users:manage")}
      userId={userId}
    />
  );
}
