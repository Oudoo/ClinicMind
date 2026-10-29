import { AssistantChat } from "@/components/clinicmind/assistant-chat";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { getActingContext } from "@/lib/auth/session";
import { canUseAssistant } from "@/lib/auth/rbac";
import { db, notDeleted } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Doctor AI assistant. `?patientId=` pre-selects a patient context (used by
 * links from a patient's record); the id must belong to the acting tenant.
 * Roles without `ai:assistant` (reception, nurses, assistants) and anyone
 * without the clinician mark (the AI lead, the platform admin) get a short
 * explanation instead of a chat that would refuse every question.
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const { patientId } = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!canUseAssistant(ctx)) {
    return (
      <div className="space-y-4">
        <SectionTitle title="AI Assistant" description="Clinical questions over your clinic's records, with citations." />
        <Card>
          <EmptyState
            title="The AI assistant is not available for your role"
            hint="It answers clinical questions over patient records: doctors, and the clinic owner with the clinician mark."
          />
        </Card>
      </div>
    );
  }

  const patient = patientId
    ? await db.patient.findFirst({
        where: { id: patientId, tenantId: ctx.tenantId, ...notDeleted },
        select: { id: true, fullName: true },
      })
    : null;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Assistant"
        description="List questions are answered from every record; other questions from the most relevant records, with citations."
      />
      <AssistantChat initialPatient={patient} />
    </div>
  );
}
