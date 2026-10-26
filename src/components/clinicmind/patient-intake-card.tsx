import Link from "next/link";
import type { IntakeStatus, UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getPatientIntake } from "@/modules/intake/service";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { SendIntakeLinkButton } from "@/components/clinicmind/intake-patient-actions";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";

const STATUS_TONE: Record<IntakeStatus, BadgeTone> = { PENDING: "warning", ACCEPTED: "success", REJECTED: "danger" };

/**
 * Onboarding: send this patient a pre-filled intake link, see submissions.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientIntakeCard({
  tenantId,
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
  if (!can(role, "patients:read")) return null;
  const [{ patient, links, submissions }, timezone] = await Promise.all([getPatientIntake(tenantId, patientId), getTenantTimezone(tenantId)]);
  if (!patient) return null;
  const activeLinks = links.filter((l) => l.status === "active");
  const canReview = can(role, "patients:write");

  return (
    <Card className="space-y-3">
      <SectionTitle
        title="Onboarding"
        description="Pre-visit form, sent as a link."
        action={canWrite ? <SendIntakeLinkButton patient={{ id: patient.id, fullName: patient.fullName, language: patient.language }} /> : null}
      />

      {submissions.length ? (
        <ul className="space-y-2">
          {submissions.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Form {s.status === "PENDING" ? "awaiting review" : s.status === "ACCEPTED" ? "accepted" : "rejected"}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {formatDateInTz(new Date(s.submittedAt), timezone)}
                  {s.data.treatmentKeys.length ? ` · ${s.data.treatmentKeys.join(", ")}` : ""}
                </p>
                {canReview && s.status === "PENDING" ? (
                  <Link href="/dashboard/patients/intake?status=PENDING" className="text-xs text-accent underline-offset-2 hover:underline">
                    Review in the queue
                  </Link>
                ) : null}
              </div>
              <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No onboarding form received yet.</p>
      )}

      {activeLinks.length ? (
        <p className="text-xs text-muted-foreground">
          {activeLinks.length === 1 ? "An active link" : `${activeLinks.length} active links`} · latest expires{" "}
          {formatDateInTz(new Date(activeLinks[0]!.expiresAt), timezone)}
          {activeLinks[0]!.uses ? ` · used ${activeLinks[0]!.uses}×` : " · not used yet"}
        </p>
      ) : null}
    </Card>
  );
}
