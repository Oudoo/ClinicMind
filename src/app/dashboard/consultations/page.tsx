import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { countPendingReview, listConsultations } from "@/modules/consultations/service";
import { ConsultationsWorkspace } from "@/components/clinicmind/consultation-workspace";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

/**
 * Consultation Intelligence: recent consultations (drafts awaiting review
 * first) beside the capture / review / sign panel. `?id=` opens a
 * consultation; `?patientId=` preselects a patient for a new capture.
 */
export default async function ConsultationsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; patientId?: string }>;
}) {
  const { id, patientId } = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "consultations:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Consultation Intelligence" description="Transcript → extract → review → sign." />
        <Card>
          <EmptyState
            title="Consultations are not available for your role"
            hint="Ask a clinic owner if you need access to the clinical workflow."
          />
        </Card>
      </div>
    );
  }

  const [initial, pending, presetPatient] = await Promise.all([
    listConsultations(ctx.tenantId, { page: 1, pageSize: 30 }),
    countPendingReview(ctx.tenantId),
    patientId
      ? db.patient.findFirst({
          where: { id: patientId, tenantId: ctx.tenantId, deletedAt: null },
          select: { id: true, fullName: true, phone: true },
        })
      : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Consultation Intelligence"
        description="Transcript → extract → review → sign. Nothing reaches the patient record until a clinician signs."
        action={
          <Badge tone={pending ? "warning" : "default"}>
            {pending} pending review
          </Badge>
        }
      />
      <ConsultationsWorkspace
        initial={initial}
        canSign={can(ctx.role, "consultations:sign")}
        userId={ctx.userId}
        openId={id}
        presetPatient={presetPatient}
      />
    </div>
  );
}
