import { getActingContext } from "@/lib/auth/session";
import { listPatients } from "@/modules/patients/service";
import { Card, SectionTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { ageFrom, initials } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PatientsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const ctx = await getActingContext();
  const patients = ctx ? await listPatients(ctx.tenantId, searchParams.q) : [];

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Patient CRM"
        description="Unified patient registry with clinical context."
        action={<Badge tone="accent">{patients.length} records</Badge>}
      />

      <Card className="p-0">
        {patients.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-5 py-3 data-label font-normal">Patient</th>
                <th className="px-5 py-3 data-label font-normal">Age</th>
                <th className="px-5 py-3 data-label font-normal">Contact</th>
                <th className="px-5 py-3 data-label font-normal">Conditions</th>
                <th className="px-5 py-3 data-label font-normal text-right">Activity</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => {
                const conditions = Array.isArray(p.medicalHistory?.chronicConditions)
                  ? (p.medicalHistory!.chronicConditions as unknown[])
                  : [];
                return (
                  <tr key={p.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-muted font-mono text-xs text-accent">
                          {initials(p.fullName)}
                        </span>
                        <span className="font-medium">{p.fullName}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3 font-mono tabular-nums text-muted-foreground">
                      {ageFrom(p.dateOfBirth) ?? "—"}
                    </td>
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground">
                      {p.phone ?? p.email ?? "—"}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {conditions.slice(0, 2).map((c, i) => (
                          <Badge key={i}>{String(c)}</Badge>
                        ))}
                        {conditions.length > 2 ? <Badge>+{conditions.length - 2}</Badge> : null}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">
                      {p._count.appointments} appts · {p._count.visits} visits
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-6">
            <EmptyState
              title="No patients yet"
              hint="Patients created via the AI receptionist or manually will appear here."
            />
          </div>
        )}
      </Card>
    </div>
  );
}
