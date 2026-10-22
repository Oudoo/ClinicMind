import { AssistantChat } from "@/components/clinicmind/assistant-chat";
import { SectionTitle } from "@/components/ui/primitives";
import { getActingContext } from "@/lib/auth/session";
import { db, notDeleted } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Doctor AI assistant. `?patientId=` pre-selects a patient context (used by
 * links from a patient's record); the id must belong to the acting tenant.
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ patientId?: string }> }) {
  const { patientId } = await searchParams;
  const ctx = await getActingContext();
  const patient =
    ctx && patientId
      ? await db.patient.findFirst({
          where: { id: patientId, tenantId: ctx.tenantId, ...notDeleted },
          select: { id: true, fullName: true },
        })
      : null;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Assistant"
        description="Retrieval-grounded clinical chat over your clinic's records, with citations."
      />
      <AssistantChat initialPatient={patient} />
    </div>
  );
}
