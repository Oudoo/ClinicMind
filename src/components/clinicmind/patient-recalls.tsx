import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listPatientRecalls } from "@/modules/recalls/service";
import { PatientRecallPanel } from "./patient-recall-panel";

/**
 * The patient's recalls on their record: everything still being worked (with
 * the desk's actions and each one's log), the last ones ended, and "Add" for
 * a review no rule makes. Rendered by the patient page beside the next
 * appointment. Server component.
 */
export async function PatientRecalls({ tenantId, role, patientId, archived }: { tenantId: string; role: UserRole; patientId: string; archived: boolean }) {
  if (!can(role, "recalls:read")) return null;
  const [{ active, closed }, timezone] = await Promise.all([listPatientRecalls(tenantId, patientId), getTenantTimezone(tenantId)]);
  return <PatientRecallPanel patientId={patientId} active={active} closed={closed} timezone={timezone} canWrite={!archived && can(role, "recalls:write")} />;
}
