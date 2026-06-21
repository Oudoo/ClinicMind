import { getActingContext } from "@/lib/auth/session";
import { listPatients } from "@/modules/patients/service";
import { ConsultationPanel } from "@/components/clinicmind/consultation-panel";
import { SectionTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function ConsultationsPage() {
  const ctx = await getActingContext();
  const patients = ctx ? await listPatients(ctx.tenantId) : [];

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Consultation Intelligence"
        description="Record → transcribe → extract → review → sign. Decisions are never auto-saved."
      />
      {patients.length ? (
        <ConsultationPanel patients={patients.map((p) => ({ id: p.id, fullName: p.fullName }))} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Add a patient first to start a consultation.
        </p>
      )}
    </div>
  );
}
