import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import { labOrderOptions, patientLabOrders } from "@/modules/lab/orders";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { dayLabel } from "./expense-shared";
import { LabStatusBadge } from "./lab-shared";
import { NewLabOrderButton } from "./lab-actions";

/**
 * The patient's lab work on their page: what went to which lab and where
 * from, where it stands (late, at the lab, back, flagged), and for the
 * clinicians what the result says; a new order for whoever sends them.
 * Server component: it fetches what it needs.
 */
export async function PatientLabCard({ tenantId, role, patientId, canWrite }: { tenantId: string; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "lab:read")) return null;
  const mayOrder = canWrite && can(role, "lab:write");
  const [patient, orders, timezone, options] = await Promise.all([
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, fullName: true } }),
    patientLabOrders(tenantId, patientId, { role }),
    getTenantTimezone(tenantId),
    mayOrder ? labOrderOptions(tenantId, patientId) : null,
  ]);
  if (!patient) return null;
  return (
    <Card className="space-y-3" aria-label="Lab work" data-testid="patient-lab">
      <SectionTitle
        title="Lab work"
        description="Samples and tests sent to labs, and their results."
        action={mayOrder && options ? <NewLabOrderButton patient={patient} options={options} timezone={timezone} label="New" variant="outline" /> : null}
      />
      {orders.length ? (
        <ul className="divide-y divide-border">
          {orders.map((o) => (
            <li key={o.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <Link href={`/dashboard/lab/${o.id}`} className="text-sm font-medium underline-offset-2 hover:underline">
                  {o.tests}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {o.lab.name}
                  {o.site ? ` · ${o.site}` : ""} · sent {dayLabel(o.sentOn, { year: false })}
                </div>
                {o.result ? <p className="mt-1 line-clamp-2 text-xs">{o.result}</p> : null}
              </div>
              <LabStatusBadge order={o} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No lab work" hint={mayOrder ? "Send a biopsy, blood tests or a culture to a lab with New." : undefined} />
      )}
    </Card>
  );
}
