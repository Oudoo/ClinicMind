import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can, canAskEvidence, canSignClinical } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { getAppointment, getTenantTimezone } from "@/modules/appointments/service";
import { toAppointmentDTO } from "@/modules/appointments/dto";
import { countPendingReview, listConsultations } from "@/modules/consultations/service";
import { countRecentOverrides, overrideScope } from "@/modules/consultations/safety/overrides";
import { ConsultationsWorkspace } from "@/components/clinicmind/consultation-workspace";
import { EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Consultations: recent consultations (drafts awaiting review first) beside
 * the capture / review / sign panel. `?id=` opens a consultation;
 * `?patientId=` preselects a patient for a new capture; `?appointmentId=`
 * (from "Start consultation") preselects that booking's patient and shows
 * the notes dictated at booking beside the capture form.
 */
export default async function ConsultationsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; patientId?: string; appointmentId?: string }>;
}) {
  const { id, patientId, appointmentId } = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "consultations:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Consultations" />
        <EmptyState
          title="Consultations are not available for your role"
          hint="Ask a clinic owner if you need access to the clinical workflow."
        />
      </div>
    );
  }

  // The owner reviews everyone's prescribing-safety overrides, a doctor their own.
  const canReviewOverrides = can(ctx.role, "reports:read") && (can(ctx.role, "audit:read") || Boolean(ctx.userId));
  const [initial, pending, patientPreset, appointment, timezone, recentOverrides] = await Promise.all([
    listConsultations(ctx.tenantId, { page: 1, pageSize: 30 }),
    countPendingReview(ctx.tenantId),
    patientId
      ? db.patient.findFirst({
          where: { id: patientId, tenantId: ctx.tenantId, deletedAt: null },
          select: { id: true, fullName: true, phone: true },
        })
      : Promise.resolve(null),
    // Tenant-scoped: another tenant's id (or a missing one) is simply ignored.
    appointmentId ? getAppointment(ctx.tenantId, appointmentId.slice(0, 64)) : Promise.resolve(null),
    getTenantTimezone(ctx.tenantId),
    canReviewOverrides ? countRecentOverrides(ctx.tenantId, overrideScope(ctx)) : Promise.resolve(0),
  ]);
  const presetPatient = appointment ? { id: appointment.patient.id, fullName: appointment.patient.fullName } : patientPreset;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Consultations"
        description="Nothing reaches the patient record until a clinician signs."
        action={
          canReviewOverrides ? (
            <Button asChild variant="outline">
              <Link
                href="/dashboard/safety"
                title={
                  recentOverrides > 0
                    ? `${formatNumber(recentOverrides)} prescribing-safety ${recentOverrides === 1 ? "stop" : "stops"} signed through in the last 28 days`
                    : "Prescribing-safety stops signed through with a reason, and acknowledged warnings"
                }
              >
                <ShieldAlert className="h-4 w-4" />
                Safety overrides
                {recentOverrides > 0 ? <span className="tabular-nums text-muted-foreground">· {formatNumber(recentOverrides)}</span> : null}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <ConsultationsWorkspace
        initial={initial}
        pendingCount={pending}
        canSign={canSignClinical(ctx)}
        canAskEvidence={canAskEvidence(ctx)}
        userId={ctx.userId}
        openId={id}
        presetPatient={presetPatient}
        presetAppointment={appointment ? toAppointmentDTO(appointment) : null}
        timezone={timezone}
      />
    </div>
  );
}
