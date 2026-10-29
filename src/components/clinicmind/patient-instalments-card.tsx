import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { dateKeyInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { patientPlans } from "@/modules/finance/instalments";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { NewInstalmentPlanButton } from "./instalment-plan-dialog";
import { InstalmentPlanList } from "./instalment-plan-list";

/**
 * The patient's instalment plans on their page: what each pays for, how much
 * is paid, the next instalment and the schedule; for the desk a new plan, a
 * payment towards one, a reminder now, or stopping one. For the roles that
 * see payments (the desk and the owner). Server component: it fetches what
 * it needs.
 */
export async function PatientInstalmentsCard({ tenantId, role, patientId, canWrite }: { tenantId: string; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "payments:write") && !can(role, "finance:read")) return null;
  const canPay = canWrite && can(role, "payments:write");
  const [patient, plans, timezone] = await Promise.all([
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, fullName: true } }),
    patientPlans(tenantId, patientId),
    getTenantTimezone(tenantId),
  ]);
  if (!patient) return null;
  return (
    <Card className="space-y-3" aria-label="Instalment plans">
      <SectionTitle
        title="Instalment plans"
        description="Treatment paid over time, with a reminder before each instalment."
        action={canPay ? <NewInstalmentPlanButton patientId={patient.id} patientName={patient.fullName} todayKey={dateKeyInTz(new Date(), timezone)} label="New" /> : null}
      />
      {plans.length ? (
        <InstalmentPlanList plans={plans} patient={patient} timezone={timezone} canPay={canPay} canRefund={can(role, "tenant:manage")} />
      ) : (
        <EmptyState title="No instalment plan" hint={canPay ? "Make one when the patient pays for a treatment over months." : undefined} />
      )}
    </Card>
  );
}
