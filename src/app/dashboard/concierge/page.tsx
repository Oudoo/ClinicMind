import Link from "next/link";
import type { Metadata } from "next";
import { getActingContext } from "@/lib/auth/session";
import { can, assertCanSignClinical, canSignClinical } from "@/lib/auth/rbac";
import { formatDateInTz, formatDateTimeInTz, formatTimeInTz, isSameDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import { countOpenEscalations } from "@/modules/concierge/escalations";
import { ENROLMENT_STATUSES, getBoard, listEnrolments, listTreatmentProtocols, onCallNow } from "@/modules/concierge/service";
import { listRosterCandidates, readConciergeSettings, resolveRoster } from "@/modules/concierge/settings";
import type { EnrolmentStatus, EnrolmentSummaryDTO } from "@/modules/concierge/dto";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ConciergeTabs, type ConciergeTab } from "@/components/clinicmind/concierge-tabs";
import { ConciergeBoard } from "@/components/clinicmind/concierge-board";
import { EnrolmentFilters } from "@/components/clinicmind/concierge-enrolment-filters";
import { EnrolmentStatusBadge, StepKindIcon, TriageBadge } from "@/components/clinicmind/concierge-badges";
import { ProtocolManager } from "@/components/clinicmind/protocol-manager";
import { ConciergeSettingsForm } from "@/components/clinicmind/concierge-settings-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Concierge" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const TABS: ConciergeTab[] = ["board", "enrolments", "protocols", "roster"];

/**
 * `/dashboard/concierge?tab=board|enrolments|protocols|roster` — the
 * post-treatment concierge (Module 5): the live board of escalations and
 * today's check-ins with the two targets, every enrolment, the protocol
 * versions per treatment, and the roster with in-hours / out-of-hours
 * acknowledgement targets.
 */
export default async function ConciergePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "concierge:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Concierge" description="Post-treatment follow-up: protocols, check-ins and escalations." />
        <Card>
          <EmptyState title="The concierge is not available for your role" hint="Nurses, doctors, reception and the clinic owner follow patients after their procedures." />
        </Card>
      </div>
    );
  }

  const tabRaw = first(sp.tab) as ConciergeTab | undefined;
  const tab: ConciergeTab = tabRaw && TABS.includes(tabRaw) ? tabRaw : "board";
  const canWrite = can(ctx.role, "concierge:write");
  const counts = await countOpenEscalations(ctx.tenantId);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Concierge"
        description="After every signed procedure: instructions, check-ins and photos on schedule, and anything out of range in front of a named person within minutes."
        action={
          counts.open ? (
            <Badge tone={counts.overdue ? "danger" : "warning"}>
              {counts.open} open{counts.overdue ? ` · ${counts.overdue} overdue` : ""}
            </Badge>
          ) : (
            <Badge tone="success">No open escalations</Badge>
          )
        }
      />
      <ConciergeTabs active={tab} badges={{ board: counts.open }} />
      {tab === "board" ? <BoardTab tenantId={ctx.tenantId} canWrite={canWrite} /> : null}
      {tab === "enrolments" ? <EnrolmentsTab tenantId={ctx.tenantId} sp={sp} /> : null}
      {tab === "protocols" ? <ProtocolsTab tenantId={ctx.tenantId} canWrite={canWrite} canApprove={canWrite && canSignClinical(ctx)} /> : null}
      {tab === "roster" ? <RosterTab tenantId={ctx.tenantId} canEdit={can(ctx.role, "tenant:manage")} /> : null}
    </div>
  );
}

async function BoardTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const board = await getBoard(tenantId);
  return <ConciergeBoard initial={board} canWrite={canWrite} />;
}

async function EnrolmentsTab({ tenantId, sp }: { tenantId: string; sp: SearchParams }) {
  const statusRaw = first(sp.status);
  const status = ENROLMENT_STATUSES.includes(statusRaw as EnrolmentStatus) ? (statusRaw as EnrolmentStatus) : undefined;
  const treatmentId = first(sp.treatmentId) || undefined;
  const q = first(sp.q)?.slice(0, 80) || undefined;
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1);
  const [result, treatments, timezone] = await Promise.all([
    listEnrolments(tenantId, { status, treatmentId, q, page, pageSize: 20 }),
    listTreatments(tenantId),
    getTenantTimezone(tenantId),
  ]);
  const now = new Date();
  const when = (iso: string) => {
    const d = new Date(iso);
    return isSameDayInTz(d, now, timezone) ? `today ${formatTimeInTz(d, timezone)}` : formatDateTimeInTz(d, timezone);
  };

  return (
    <Card className="overflow-hidden p-0">
      <EnrolmentFilters filters={{ status, treatmentId, q }} counts={result.counts} treatments={treatments.map((t) => ({ id: t.id, name: t.name }))} />
      {result.enrolments.length ? (
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Patient</TH>
              <TH className="hidden md:table-cell">Protocol</TH>
              <TH>Progress</TH>
              <TH className="hidden lg:table-cell">Next step</TH>
              <TH className="hidden md:table-cell">Last check-in</TH>
              <TH className="hidden sm:table-cell">Status</TH>
            </TR>
          </THead>
          <TBody>
            {result.enrolments.map((e) => (
              <EnrolmentRow key={e.id} e={e} when={when} timezone={timezone} />
            ))}
          </TBody>
        </Table>
      ) : (
        <div className="p-5">
          <EmptyState
            title={status || treatmentId || q ? "No enrolment matches these filters" : "No enrolments yet"}
            hint="A patient is enrolled the moment a doctor signs their procedure."
          />
        </div>
      )}
      {result.total > result.pageSize ? (
        <Pagination
          page={result.page}
          pageSize={result.pageSize}
          total={result.total}
          basePath="/dashboard/concierge"
          query={{ tab: "enrolments", status, treatmentId, q }}
          className="border-t border-border"
        />
      ) : null}
    </Card>
  );
}

function EnrolmentRow({ e, when, timezone }: { e: EnrolmentSummaryDTO; when: (iso: string) => string; timezone: string }) {
  const p = e.progress;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const href = `/dashboard/concierge/enrolments/${e.id}`;
  return (
    <TR>
      <TD className="max-w-[12rem] sm:max-w-none">
        <Link href={href} className="font-medium underline-offset-2 hover:text-accent hover:underline">
          {e.patient.fullName}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {e.treatment.name} · {formatDateInTz(new Date(e.procedure.performedAt), timezone)}
        </p>
        <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
          <EnrolmentStatusBadge status={e.status} />
          {p.openEscalations ? <Badge tone="danger">{p.openEscalations} open</Badge> : null}
        </div>
      </TD>
      <TD className="hidden md:table-cell">
        <p className="text-sm">{e.protocol.name}</p>
        <p className="font-mono text-xs text-muted-foreground">v{e.protocol.version}</p>
      </TD>
      <TD>
        <p className="whitespace-nowrap font-mono text-xs tabular-nums">
          {e.status === "ACTIVE" || e.status === "PAUSED" ? `Day ${Math.min(p.day, e.protocol.lengthDays)} of ${e.protocol.lengthDays}` : `${p.done}/${p.total} steps`}
        </p>
        <div className="mt-1 h-1.5 w-20 overflow-hidden rounded bg-muted sm:w-28" aria-hidden="true">
          <div className="h-full rounded bg-accent" style={{ width: `${pct}%` }} />
        </div>
        {p.awaiting ? <p className="mt-1 text-[11px] text-muted-foreground">{p.awaiting} awaiting answer</p> : null}
      </TD>
      <TD className="hidden lg:table-cell">
        {p.nextTitle && p.nextDueAt && p.nextKind ? (
          <span className="flex items-start gap-1.5 text-sm">
            <StepKindIcon kind={p.nextKind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              {p.nextTitle}
              <span className="block text-xs text-muted-foreground">{when(p.nextDueAt)}</span>
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TD>
      <TD className="hidden md:table-cell">
        {p.lastTriage && p.lastCheckInAt ? (
          <div className="space-y-1">
            <TriageBadge level={p.lastTriage} />
            <p className="text-xs text-muted-foreground">{when(p.lastCheckInAt)}</p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">No answer yet</span>
        )}
        {p.openEscalations ? <Badge tone="danger" className="mt-1">{p.openEscalations} open escalation{p.openEscalations === 1 ? "" : "s"}</Badge> : null}
      </TD>
      <TD className="hidden sm:table-cell">
        <EnrolmentStatusBadge status={e.status} />
      </TD>
    </TR>
  );
}

async function ProtocolsTab({ tenantId, canWrite, canApprove }: { tenantId: string; canWrite: boolean; canApprove: boolean }) {
  const [treatments, timezone] = await Promise.all([listTreatmentProtocols(tenantId), getTenantTimezone(tenantId)]);
  return <ProtocolManager treatments={treatments} timezone={timezone} canWrite={canWrite} canApprove={canApprove} />;
}

async function RosterTab({ tenantId, canEdit }: { tenantId: string; canEdit: boolean }) {
  const settings = await readConciergeSettings(tenantId);
  const [candidates, roster, onCall, timezone] = await Promise.all([
    listRosterCandidates(tenantId),
    resolveRoster(tenantId, settings),
    onCallNow(tenantId),
    getTenantTimezone(tenantId),
  ]);
  return (
    <ConciergeSettingsForm
      initial={settings}
      candidates={candidates.map((c) => ({ id: c.id, fullName: c.fullName, role: c.role }))}
      effective={{
        inHours: roster.inHours ? { fullName: roster.inHours.fullName, isDefault: roster.defaults.inHours } : null,
        outOfHours: roster.outOfHours ? { fullName: roster.outOfHours.fullName, isDefault: roster.defaults.outOfHours } : null,
        backup: roster.backup ? { fullName: roster.backup.fullName, isDefault: roster.defaults.backup } : null,
      }}
      onCall={onCall}
      timezone={timezone}
      canEdit={canEdit}
    />
  );
}
