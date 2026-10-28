import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { cn, formatNumber } from "@/lib/utils";
import { formatDateInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import {
  LeadListQuery,
  boardLeads,
  followUpCounts,
  leadOverview,
  listCampaignRefs,
  listCampaigns,
  listFollowUps,
  listLeads,
  listTenantStaff,
  type LeadListFilter,
} from "@/modules/crm/service";
import { CHANNEL_LABELS, FOLLOW_UP_SCOPES, ageLabel, waMeLink, type FollowUpScope } from "@/modules/crm/shared";
import { Badge, Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LeadBoard } from "@/components/clinicmind/lead-board";
import { LeadFilters } from "@/components/clinicmind/lead-filters";
import { NewLeadButton } from "@/components/clinicmind/lead-new-dialog";
import { CompleteFollowUpButton } from "@/components/clinicmind/lead-follow-ups";
import { CampaignRowActions, NewCampaignButton } from "@/components/clinicmind/campaign-manager";
import {
  LEADS_TABS,
  LEAD_FILTER_KEYS,
  OwnerChip,
  PLATFORM_LABELS,
  SourceBadge,
  StageBadge,
  leadsHref,
  overdueLabel,
  whenLabel,
  type LeadQueryState,
  type LeadsTab,
} from "@/components/clinicmind/lead-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const TAB_LABELS: Record<LeadsTab, string> = { pipeline: "Pipeline", list: "List", "follow-ups": "Follow-ups", campaigns: "Campaigns" };
const SCOPE_LABELS: Record<FollowUpScope, string> = { due: "Due today", overdue: "Overdue", mine: "Mine" };

function firstValue(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/** The list filters from the URL; a value the API would refuse is dropped instead of failing the page. */
function parseLeadQuery(sp: SearchParams): { filter: LeadListFilter; state: LeadQueryState } {
  const raw: Record<string, string> = {};
  for (const key of [...LEAD_FILTER_KEYS, "sort", "page"]) {
    const v = firstValue(sp, key)?.trim();
    if (v) raw[key] = v.slice(0, 100);
  }
  let parsed = LeadListQuery.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) delete raw[String(issue.path[0])];
    parsed = LeadListQuery.safeParse(raw);
  }
  const filter = parsed.success ? parsed.data : LeadListQuery.parse({});
  const state: LeadQueryState = {};
  for (const key of [...LEAD_FILTER_KEYS, "sort"] as const) if (raw[key]) state[key] = raw[key];
  return { filter, state };
}

/**
 * `/dashboard/leads?tab=pipeline|list|follow-ups|campaigns` — the CRM: the
 * pipeline board, the filtered list, the follow-up queues and the ads
 * campaigns with their spend. leads:read to see it, leads:write to change it.
 */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "leads:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Leads" />
        <Card>
          <EmptyState title="Leads are not available for your role" hint="Ask the clinic owner if you need to see the pipeline." />
        </Card>
      </div>
    );
  }

  const tabParam = firstValue(sp, "tab");
  const tab: LeadsTab = (LEADS_TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as LeadsTab) : "pipeline";
  const canWrite = can(ctx.role, "leads:write");
  const now = new Date();
  const { filter, state } = parseLeadQuery(sp);

  const [timezone, treatments, staff, campaignRefs, overview, counts] = await Promise.all([
    getTenantTimezone(ctx.tenantId),
    listTreatments(ctx.tenantId),
    listTenantStaff(ctx.tenantId),
    listCampaignRefs(ctx.tenantId),
    leadOverview(ctx.tenantId, now),
    followUpCounts(ctx.tenantId, ctx.userId, now),
  ]);
  const treatmentNames = Object.fromEntries(treatments.map((t) => [t.key, t.name]));
  const treatmentOptions = treatments.map((t) => ({ key: t.key, name: t.name }));
  const formOptions = { treatments: treatmentOptions, staff, campaigns: campaignRefs };
  const filterProps = { staff, treatments: treatmentOptions, campaigns: campaignRefs };
  const pipelineState: LeadQueryState = { ...state, stage: undefined, sort: undefined };

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Leads"
        description="Every enquiry from the ads, Instagram, the website, referrals and the desk, through to a booked consultation."
        action={canWrite ? <NewLeadButton options={formOptions} defaultOwnerId={ctx.role === "RECEPTIONIST" ? ctx.userId : null} /> : null}
      />

      <Bento>
        <Metric label="Open leads" value={overview.open} hint="Not yet won or lost" />
        <Metric label="New this week" value={overview.newThisWeek} tone="accent" hint="Last 7 days" />
        <Metric label="Won" value={overview.wonThisMonth} hint="Last 30 days" />
        <Metric label="Follow-ups overdue" value={overview.overdue} tone={overview.overdue ? "warning" : "default"} hint={overview.overdue ? "Past their time" : "Nothing late"} />
      </Bento>

      <nav aria-label="Leads views" className="inline-flex h-auto max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
        {LEADS_TABS.map((t) => {
          const href = t === "pipeline" ? leadsHref("pipeline", pipelineState) : t === "list" ? leadsHref("list", state) : leadsHref(t);
          return (
            <Link
              key={t}
              href={href}
              aria-current={tab === t ? "page" : undefined}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {TAB_LABELS[t]}
              {t === "follow-ups" && counts.overdue ? <Badge tone="danger">{counts.overdue}</Badge> : null}
            </Link>
          );
        })}
      </nav>

      {tab === "pipeline" ? (
        <Card className="overflow-hidden p-0">
          <LeadFilters tab="pipeline" query={pipelineState} {...filterProps} />
          <div className="p-3 sm:p-4">
            <LeadBoard
              columns={await boardLeads(ctx.tenantId, filter)}
              treatmentNames={treatmentNames}
              canWrite={canWrite}
              timezone={timezone}
              now={now}
              query={pipelineState}
            />
          </div>
        </Card>
      ) : null}

      {tab === "list" ? <LeadListTab ctx={ctx} filter={filter} state={state} filterProps={filterProps} treatmentNames={treatmentNames} timezone={timezone} now={now} /> : null}

      {tab === "follow-ups" ? (
        <FollowUpsTab
          tenantId={ctx.tenantId}
          userId={ctx.userId}
          scope={(FOLLOW_UP_SCOPES as readonly string[]).includes(firstValue(sp, "scope") ?? "") ? (firstValue(sp, "scope") as FollowUpScope) : counts.overdue ? "overdue" : "due"}
          counts={counts}
          canWrite={canWrite}
          timezone={timezone}
          now={now}
        />
      ) : null}

      {tab === "campaigns" ? <CampaignsTab tenantId={ctx.tenantId} canWrite={canWrite} treatments={treatments.map((t) => ({ id: t.id, name: t.name }))} timezone={timezone} /> : null}
    </div>
  );
}

async function LeadListTab({
  ctx,
  filter,
  state,
  filterProps,
  treatmentNames,
  timezone,
  now,
}: {
  ctx: { tenantId: string };
  filter: LeadListFilter;
  state: LeadQueryState;
  filterProps: Omit<Parameters<typeof LeadFilters>[0], "tab" | "query">;
  treatmentNames: Record<string, string>;
  timezone: string;
  now: Date;
}) {
  const result = await listLeads(ctx.tenantId, filter);
  const filtered = Object.keys(state).some((k) => k !== "sort");
  const paginationQuery = Object.fromEntries(Object.entries({ tab: "list", ...state }).filter(([, v]) => v)) as Record<string, string>;
  return (
    <Card className="overflow-hidden p-0">
      <LeadFilters tab="list" query={state} {...filterProps} />
      {result.leads.length ? (
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Lead</TH>
              <TH>Stage</TH>
              <TH className="hidden md:table-cell">Source</TH>
              <TH className="hidden lg:table-cell">Interested in</TH>
              <TH className="hidden md:table-cell">Owner</TH>
              <TH className="hidden xl:table-cell">Campaign</TH>
              <TH className="hidden sm:table-cell">Age</TH>
              <TH className="hidden lg:table-cell">Next follow-up</TH>
            </TR>
          </THead>
          <TBody>
            {result.leads.map((lead) => {
              const due = lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt) : null;
              return (
                <TR key={lead.id}>
                  <TD className="max-w-[12rem] sm:max-w-none">
                    <Link href={`/dashboard/leads/${lead.id}`} className="block truncate font-medium underline-offset-2 hover:text-accent hover:underline">
                      {lead.fullName}
                    </Link>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{lead.phone ?? lead.email ?? "—"}</span>
                  </TD>
                  <TD>
                    <StageBadge stage={lead.stage} />
                  </TD>
                  <TD className="hidden md:table-cell">
                    <SourceBadge source={lead.source} />
                  </TD>
                  <TD className="hidden max-w-[14rem] truncate text-xs lg:table-cell">{lead.interests.map((k) => treatmentNames[k] ?? k).join(", ") || "—"}</TD>
                  <TD className="hidden md:table-cell">
                    <span className="flex items-center gap-2 text-xs">
                      <OwnerChip owner={lead.owner} />
                      <span className="hidden truncate xl:inline">{lead.owner?.fullName ?? "Unassigned"}</span>
                    </span>
                  </TD>
                  <TD className="hidden max-w-[12rem] truncate text-xs text-muted-foreground xl:table-cell">{lead.campaign?.name ?? "—"}</TD>
                  <TD className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground sm:table-cell" title={formatDateInTz(new Date(lead.createdAt), timezone)}>
                    {ageLabel(lead.createdAt, now)}
                  </TD>
                  <TD className={cn("hidden whitespace-nowrap font-mono text-xs lg:table-cell", due && due < now ? "text-danger" : "text-muted-foreground")}>
                    {due ? whenLabel(due, timezone, now) : "—"}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      ) : (
        <div className="p-6">
          <EmptyState title={filtered ? "No leads match" : "No leads yet"} hint={filtered ? "Try another name or number, or clear the filters." : "New enquiries from the inbox, the ads and the desk appear here."} />
        </div>
      )}
      {result.total > 0 ? (
        <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/dashboard/leads" query={paginationQuery} className="border-t border-border" />
      ) : null}
    </Card>
  );
}

async function FollowUpsTab({
  tenantId,
  userId,
  scope,
  counts,
  canWrite,
  timezone,
  now,
}: {
  tenantId: string;
  userId: string | null;
  scope: FollowUpScope;
  counts: { due: number; overdue: number; mine: number };
  canWrite: boolean;
  timezone: string;
  now: Date;
}) {
  const rows = await listFollowUps(tenantId, scope, userId, now);
  const empty: Record<FollowUpScope, [string, string]> = {
    due: ["Nothing due today", "Follow-ups scheduled for today on the clinic clock appear here."],
    overdue: ["Nothing overdue", "Every follow-up is on time."],
    mine: ["No open follow-ups of yours", "Follow-ups you own appear here until they are done."],
  };
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border p-4" role="navigation" aria-label="Follow-up queues">
        {FOLLOW_UP_SCOPES.map((s) => (
          <Link
            key={s}
            href={leadsHref("follow-ups", { scope: s })}
            aria-current={scope === s ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
              scope === s ? "border-accent bg-accent-muted text-accent" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {SCOPE_LABELS[s]}
            <span className={cn("font-mono", s === "overdue" && counts.overdue ? "text-danger" : undefined)}>{counts[s]}</span>
          </Link>
        ))}
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border">
          {rows.map((f) => {
            const due = new Date(f.dueAt);
            const overdue = due < now;
            const wa = waMeLink(f.lead.phone);
            return (
              <li key={f.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/leads/${f.leadId}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                      {f.lead.fullName}
                    </Link>
                    <StageBadge stage={f.lead.stage} />
                    {overdue ? <Badge tone="danger">{overdueLabel(f.dueAt, now)}</Badge> : null}
                  </div>
                  <p className="text-sm" dir="auto">{f.note ?? <span className="text-muted-foreground">No note</span>}</p>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground">
                    <span className={overdue ? "text-danger" : undefined}>Due {whenLabel(due, timezone, now)}</span>
                    {f.channel ? <span>· {CHANNEL_LABELS[f.channel]}</span> : null}
                    <span className="inline-flex items-center gap-1">
                      · <OwnerChip owner={f.owner} /> {f.owner?.fullName ?? "Unassigned"}
                    </span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {wa ? (
                    <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs hover:bg-muted" title={`WhatsApp ${f.lead.phone}`}>
                      <MessageCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                      WhatsApp
                    </a>
                  ) : null}
                  {canWrite ? <CompleteFollowUpButton followUp={{ id: f.id, leadName: f.lead.fullName, note: f.note }} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="p-6">
          <EmptyState title={empty[scope][0]} hint={empty[scope][1]} />
        </div>
      )}
    </Card>
  );
}

async function CampaignsTab({ tenantId, canWrite, treatments, timezone }: { tenantId: string; canWrite: boolean; treatments: { id: string; name: string }[]; timezone: string }) {
  const campaigns = await listCampaigns(tenantId);
  const totals = campaigns.reduce((s, c) => ({ leads: s.leads + c.leads, consultations: s.consultations + c.consultations, won: s.won + c.won, cost: s.cost + c.totalCost }), { leads: 0, consultations: 0, won: 0, cost: 0 });
  const egp = (n: number) => `${formatNumber(n)} EGP`;
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <p className="font-display text-base font-semibold tracking-tight">Ads campaigns</p>
          <p className="text-sm text-muted-foreground">Leads, consultations and spend per campaign. Costs are entered by period or imported as CSV.</p>
        </div>
        {canWrite ? <NewCampaignButton treatments={treatments} /> : null}
      </div>
      {campaigns.length ? (
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Campaign</TH>
              <TH className="hidden sm:table-cell">Platform</TH>
              <TH className="text-right">Leads</TH>
              <TH className="hidden text-right md:table-cell">Consultations</TH>
              <TH className="hidden text-right lg:table-cell">Won</TH>
              <TH className="text-right">Total cost</TH>
              <TH className="hidden text-right lg:table-cell">Per lead</TH>
              {canWrite ? <TH className="w-10"><span className="sr-only">Actions</span></TH> : null}
            </TR>
          </THead>
          <TBody>
            {campaigns.map((c) => (
              <TR key={c.id}>
                <TD className="max-w-[11rem] sm:max-w-xs">
                  <span className="block truncate font-medium" title={c.name}>
                    {c.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{c.treatment?.name ?? "Brand (any treatment)"}</span>
                  <span className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                    <span className="truncate">{c.externalId}</span>
                    {c.active ? null : <Badge>ended</Badge>}
                    {c.startedAt ? <span className="hidden md:inline">· since {formatDateInTz(new Date(c.startedAt), timezone, { day: "2-digit", month: "short", year: "numeric" })}</span> : null}
                  </span>
                </TD>
                <TD className="hidden sm:table-cell">
                  <Badge tone={c.platform === "META" ? "accent" : c.platform === "GOOGLE" ? "success" : "default"}>{PLATFORM_LABELS[c.platform]}</Badge>
                </TD>
                <TD className="text-right font-mono tabular-nums">
                  <Link href={leadsHref("list", { campaignId: c.id })} className="hover:text-accent hover:underline">
                    {c.leads}
                  </Link>
                </TD>
                <TD className="hidden text-right font-mono tabular-nums md:table-cell">{c.consultations}</TD>
                <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{c.won}</TD>
                <TD className="whitespace-nowrap text-right font-mono text-xs tabular-nums">{egp(c.totalCost)}</TD>
                <TD className="hidden whitespace-nowrap text-right font-mono text-xs tabular-nums text-muted-foreground lg:table-cell">{c.leads ? egp(Math.round(c.totalCost / c.leads)) : "—"}</TD>
                {canWrite ? (
                  <TD className="px-2 text-right">
                    <CampaignRowActions campaign={c} treatments={treatments} />
                  </TD>
                ) : null}
              </TR>
            ))}
            <TR className="bg-muted/40 font-medium hover:bg-muted/40">
              <TD>Total</TD>
              <TD className="hidden sm:table-cell" />
              <TD className="text-right font-mono tabular-nums">{totals.leads}</TD>
              <TD className="hidden text-right font-mono tabular-nums md:table-cell">{totals.consultations}</TD>
              <TD className="hidden text-right font-mono tabular-nums lg:table-cell">{totals.won}</TD>
              <TD className="whitespace-nowrap text-right font-mono text-xs tabular-nums">{egp(totals.cost)}</TD>
              <TD className="hidden whitespace-nowrap text-right font-mono text-xs tabular-nums lg:table-cell">{totals.leads ? egp(Math.round(totals.cost / totals.leads)) : "—"}</TD>
              {canWrite ? <TD /> : null}
            </TR>
          </TBody>
        </Table>
      ) : (
        <div className="p-6">
          <EmptyState title="No campaigns yet" hint="Add the campaigns running on Meta and Google so their leads and costs line up." />
        </div>
      )}
    </Card>
  );
}
