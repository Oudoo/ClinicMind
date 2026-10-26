import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { can } from "@/lib/auth/rbac";
import { formatDateTimeInTz, formatDateInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { patientConciergeSummary } from "@/modules/concierge/service";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { EnrolmentStatusBadge, StepKindIcon, TriageBadge } from "@/components/clinicmind/concierge-badges";

/**
 * Concierge: the running enrolment, next check-in, last answers, escalations.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 */
export async function PatientConciergeCard({
  tenantId,
  role,
  patientId,
}: {
  tenantId: string;
  userId: string | null;
  role: UserRole;
  patientId: string;
  canWrite: boolean;
}) {
  if (!can(role, "concierge:read")) return null;
  const [summary, timezone] = await Promise.all([patientConciergeSummary(tenantId, patientId), getTenantTimezone(tenantId)]);

  if (!summary) {
    return (
      <Card className="space-y-2">
        <SectionTitle title="Concierge" description="Post-treatment follow-up." />
        <p className="text-sm text-muted-foreground">Not enrolled. Patients are enrolled when a doctor signs their procedure.</p>
      </Card>
    );
  }

  const { enrolment: e, openEscalation: esc } = summary;
  const p = e.progress;
  const running = e.status === "ACTIVE" || e.status === "PAUSED";
  const href = `/dashboard/concierge/enrolments/${e.id}`;
  const at = (iso: string) => formatDateTimeInTz(new Date(iso), timezone);

  return (
    <Card className="space-y-3">
      <SectionTitle title="Concierge" description={`${e.treatment.name} · ${formatDateInTz(new Date(e.procedure.performedAt), timezone)}`} action={<EnrolmentStatusBadge status={e.status} />} />

      {esc ? (
        <Link
          href={href}
          className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/5 p-3 text-sm hover:bg-danger/10"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <TriageBadge level={esc.level} />
              <span className="font-medium">{esc.status === "OPEN" ? "Open escalation" : "Acknowledged, not resolved"}</span>
            </span>
            <span className="mt-0.5 block break-words">{esc.summary}</span>
            <span className="block text-xs text-muted-foreground">
              {esc.assignedToName ?? "Unassigned"} · {esc.status === "OPEN" ? `acknowledge by ${at(esc.dueAt)}` : "being handled"}
            </span>
          </span>
        </Link>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="data-label">Protocol</dt>
          <dd className="truncate">
            {e.protocol.name} <span className="font-mono text-xs text-muted-foreground">v{e.protocol.version}</span>
          </dd>
        </div>
        <div>
          <dt className="data-label">{running ? "Day" : "Steps"}</dt>
          <dd className="font-mono tabular-nums">{running ? `${Math.min(p.day, e.protocol.lengthDays)} of ${e.protocol.lengthDays}` : `${p.done} of ${p.total}`}</dd>
        </div>
        <div className="col-span-2">
          <dt className="data-label">Next step</dt>
          <dd>
            {p.nextTitle && p.nextDueAt && p.nextKind ? (
              <span className="flex items-start gap-1.5">
                <StepKindIcon kind={p.nextKind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  {p.nextTitle} <span className="text-xs text-muted-foreground">· {at(p.nextDueAt)}</span>
                </span>
              </span>
            ) : (
              <span className="text-muted-foreground">Nothing scheduled</span>
            )}
            {p.awaiting ? <span className="mt-0.5 block text-xs text-muted-foreground">{p.awaiting} sent and awaiting an answer</span> : null}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="data-label">Last check-in</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {p.lastTriage && p.lastCheckInAt ? (
              <>
                <TriageBadge level={p.lastTriage} />
                <span className="text-xs text-muted-foreground">{at(p.lastCheckInAt)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">No answer yet</span>
            )}
            {p.openEscalations > 1 ? <Badge tone="danger">{p.openEscalations} open escalations</Badge> : null}
          </dd>
        </div>
      </dl>

      <Link href={href} className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline">
        Open the follow-up
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
      {summary.others ? <p className="text-xs text-muted-foreground">{summary.others} earlier follow-up{summary.others === 1 ? "" : "s"} on record.</p> : null}
    </Card>
  );
}
