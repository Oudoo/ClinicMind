import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { ArrowUpRight, Trophy } from "lucide-react";
import { db, notDeleted } from "@/lib/db";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { treatmentNames } from "@/modules/treatments/service";
import { SOURCE_LABELS, STAGE_LABELS } from "@/modules/crm/shared";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { LostReasonBadge, ObjectionBadges, SourceBadge, StageBadge } from "./lead-shared";

/**
 * CRM on the patient's page: the lead this patient came from (first touch):
 * source, campaign, what they asked about, the objections staff confirmed,
 * where the lead stands and when it was won, with a link to it. Later
 * enquiries are listed under it. Server component.
 */
export async function PatientLeadCard({ tenantId, role, patientId }: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "leads:read")) return null;
  const leads = await db.lead.findMany({
    where: { tenantId, patientId, ...notDeleted },
    orderBy: { createdAt: "asc" },
    take: 6,
    select: {
      id: true,
      fullName: true,
      source: true,
      stage: true,
      interests: true,
      objections: true,
      lostReason: true,
      wonAt: true,
      createdAt: true,
      campaign: { select: { name: true } },
    },
  });

  if (!leads.length) {
    return (
      <Card className="space-y-2">
        <SectionTitle title="Lead" />
        <p className="text-sm text-muted-foreground">No lead on record.</p>
      </Card>
    );
  }

  const [names, timezone, patient] = await Promise.all([
    treatmentNames(tenantId),
    getTenantTimezone(tenantId),
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { createdAt: true } }),
  ]);
  const [first, ...later] = leads;
  const lead = first!;
  const date = (d: Date) => formatDateInTz(d, timezone);
  // A lead that arrived well after the patient was registered is a returning patient's enquiry.
  const returning = patient ? lead.createdAt.getTime() - patient.createdAt.getTime() > 3 * 86_400_000 : false;

  return (
    <Card className="space-y-3">
      <SectionTitle
        title={returning ? "Enquired as a lead" : "Came in as a lead"}
        description={returning ? `A returning patient (registered ${date(patient!.createdAt)}).` : undefined}
        action={<StageBadge stage={lead.stage} />}
      />
      <dl className="space-y-2 text-sm">
        <Row label="Source">
          <span className="flex flex-wrap items-center justify-end gap-1.5">
            <SourceBadge source={lead.source} />
            <span className="sr-only">{SOURCE_LABELS[lead.source]}</span>
          </span>
        </Row>
        <Row label="Campaign">{lead.campaign?.name ?? <span className="text-muted-foreground">—</span>}</Row>
        <Row label="Interested in">
          {lead.interests.length ? (
            <span className="flex flex-wrap justify-end gap-1">
              {lead.interests.map((k) => (
                <Badge key={k} tone="accent">
                  {names.get(k) ?? k}
                </Badge>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Row>
        <Row label="Objections">{lead.objections.length ? <ObjectionBadges objections={lead.objections} className="justify-end" /> : <span className="text-muted-foreground">None recorded</span>}</Row>
        <Row label="First contact">{date(lead.createdAt)}</Row>
        {lead.wonAt ? (
          <Row label="Won">
            <span className="inline-flex items-center gap-1 text-success">
              <Trophy className="h-3.5 w-3.5" aria-hidden="true" />
              {date(lead.wonAt)}
            </span>
          </Row>
        ) : null}
        {lead.stage === "LOST" ? (
          <Row label="Lost">
            <LostReasonBadge reason={lead.lostReason} />
          </Row>
        ) : null}
      </dl>
      <Link href={`/dashboard/leads/${lead.id}`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
        Open the lead
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
      {later.length ? (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="data-label">Later enquiries</p>
          <ul className="space-y-1">
            {later.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 text-sm">
                <Link href={`/dashboard/leads/${l.id}`} className="min-w-0 truncate hover:text-accent hover:underline">
                  {l.interests.map((k) => names.get(k) ?? k).join(", ") || "Enquiry"} · {date(l.createdAt)}
                </Link>
                <span className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground">{STAGE_LABELS[l.stage]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="data-label shrink-0 pt-0.5">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
