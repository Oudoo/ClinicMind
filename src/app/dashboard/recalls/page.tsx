import Link from "next/link";
import type { Metadata } from "next";
import type { UserRole } from "@prisma/client";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { cn, formatNumber } from "@/lib/utils";
import { dateKeyInTz } from "@/lib/time";
import { resolvePeriod } from "@/modules/reporting/period";
import { recallResults } from "@/modules/recalls/results";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import { END_AFTER_SILENT_DAYS, END_AFTER_WINDOW_DAYS, RECALL_KIND_LABEL, RECALL_KINDS, RECALL_STATUS_LABEL, RECALL_STATUSES } from "@/modules/recalls/constants";
import { listRecallRules } from "@/modules/recalls/rules";
import { listRecalls } from "@/modules/recalls/service";
import type { RecallTab } from "@/modules/recalls/dto";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { DeltaChip, Kpi } from "@/components/ui/kpi";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PeriodPicker } from "@/components/clinicmind/report-period-picker";
import { Pagination } from "@/components/ui/pagination";
import { RecallList } from "@/components/clinicmind/recall-list";
import { RecallRules } from "@/components/clinicmind/recall-rules";
import { ConfirmCalls } from "@/components/clinicmind/confirm-calls";
import { listToConfirm } from "@/modules/appointments/reminders";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Recalls" };

type SearchParams = Record<string, string | string[] | undefined>;
type Tab = RecallTab | "rules" | "results";
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const TABS: { key: Tab; label: string; short?: string }[] = [
  { key: "today", label: "Contact today", short: "Today" },
  { key: "soon", label: "Due soon" },
  { key: "booked", label: "Booked" },
  { key: "all", label: "All" },
  { key: "results", label: "Results" },
  { key: "rules", label: "Rules" },
];

const EMPTY: Record<RecallTab, { title: string; hint: string }> = {
  today: { title: "Nobody to contact today", hint: "Recalls due and overdue land here, most urgent first. Due soon shows the next two weeks." },
  soon: { title: "Nothing due in the next two weeks", hint: "The automatic WhatsApp message goes 14 days before the due day; reception calls once it is due." },
  booked: { title: "No recall is booked", hint: "Booking from a recall, or any booking the patient makes for it, shows here until the visit." },
  all: { title: "No recalls match", hint: "Recalls are made when procedures and consultations are signed, and by the daily sweep." },
};

/**
 * `/dashboard/recalls?tab=today|soon|booked|all|rules` — reception's recall
 * list: who to contact today (due and overdue, most urgent and valuable
 * first), what is due in the next two weeks, what is booked, every recall,
 * how the recalls did (`&period=` as the reports), and the rules that make
 * them.
 */
export default async function RecallsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const header = (
    <SectionTitle
      title="Recalls"
      description="Every patient due back: reviews, a course's next session, treatment not booked, missed visits, patients not seen for a year."
    />
  );
  if (!can(ctx.role, "recalls:read")) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState title="Recalls are not available for your role" hint="Reception, nurses, doctors and the clinic owner work the recall list." />
        </Card>
      </div>
    );
  }

  const raw = first(sp.tab) as Tab | undefined;
  const tab: Tab = raw && TABS.some((t) => t.key === raw) ? raw : "today";
  // Rules and Results show no list; the badges still count.
  const listed = tab !== "rules" && tab !== "results";
  const query = {
    kind: first(sp.kind),
    owner: first(sp.owner) === "mine" ? "mine" : undefined,
    q: first(sp.q),
    status: first(sp.status),
  };
  const timezone = await getTenantTimezone(ctx.tenantId);
  const viewer = { userId: ctx.userId, role: ctx.role };
  const data = await listRecalls(
    ctx.tenantId,
    {
      tab: listed ? (tab as RecallTab) : "today",
      kind: query.kind && (RECALL_KINDS as readonly string[]).includes(query.kind) ? (query.kind as (typeof RECALL_KINDS)[number]) : undefined,
      owner: query.owner === "mine" ? "mine" : "all",
      q: query.q,
      status: tab === "all" && query.status && [...RECALL_STATUSES, "active", "closed"].includes(query.status) ? (query.status as (typeof RECALL_STATUSES)[number]) : undefined,
      page: Number(first(sp.page) ?? 1) || 1,
      pageSize: listed ? 25 : 1,
    },
    viewer,
  );
  const badges: Partial<Record<Tab, number>> = { today: data.counts.today, soon: data.counts.soon, booked: data.counts.booked };
  const href = (t: Tab) => {
    const params = new URLSearchParams();
    if (t !== "today") params.set("tab", t);
    if (t !== "rules" && t !== "results") for (const [k, v] of Object.entries({ kind: query.kind, owner: query.owner, q: query.q })) if (v) params.set(k, v);
    const s = params.toString();
    return `/dashboard/recalls${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      {header}
      <nav aria-label="Recall lists" className="-mx-1 overflow-x-auto px-1">
        <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
          {TABS.map((t) => {
            const current = t.key === tab;
            const count = badges[t.key];
            return (
              <li key={t.key}>
                <Link
                  href={href(t.key)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                    current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.short ? (
                    <>
                      <span className="sm:hidden">{t.short}</span>
                      <span className="hidden sm:inline">{t.label}</span>
                    </>
                  ) : (
                    t.label
                  )}
                  {count ? <span className={cn("rounded-md px-1.5 font-mono text-[10px]", t.key === "today" ? "bg-danger/10 text-danger" : "bg-card text-muted-foreground")}>{count}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === "rules" ? (
        <RulesTab tenantId={ctx.tenantId} canManage={can(ctx.role, "recalls:manage")} />
      ) : tab === "results" ? (
        <ResultsTab tenantId={ctx.tenantId} role={ctx.role} sp={sp} timezone={timezone} />
      ) : (
        <>
          {tab === "today" && can(ctx.role, "appointments:read") ? <BookingCalls tenantId={ctx.tenantId} timezone={timezone} canWrite={can(ctx.role, "appointments:write")} /> : null}
          <form method="get" className="flex flex-wrap items-end gap-2" role="search" aria-label="Filter recalls">
            {tab !== "today" ? <input type="hidden" name="tab" value={tab} /> : null}
            <label className="min-w-[12rem] flex-1 sm:max-w-xs">
              <span className="data-label">Patient or reason</span>
              <Input name="q" defaultValue={query.q ?? ""} placeholder="Name, phone or what for" className="mt-1" />
            </label>
            <label>
              <span className="data-label">Kind</span>
              <Select name="kind" defaultValue={query.kind ?? ""} className="mt-1">
                <option value="">Every kind</option>
                {RECALL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {RECALL_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </label>
            {tab === "all" ? (
              <label>
                <span className="data-label">State</span>
                <Select name="status" defaultValue={query.status ?? ""} className="mt-1">
                  <option value="">Any</option>
                  <option value="active">Still being worked</option>
                  <option value="closed">Ended</option>
                  {RECALL_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {RECALL_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            <label>
              <span className="data-label">Whose</span>
              <Select name="owner" defaultValue={query.owner ?? ""} className="mt-1">
                <option value="">Everyone's</option>
                <option value="mine">Mine and my role's</option>
              </Select>
            </label>
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>

          <Card className="p-0">
            <RecallList recalls={data.recalls} timezone={timezone} canWrite={can(ctx.role, "recalls:write")} empty={EMPTY[tab as RecallTab]} />
            {data.total > data.pageSize ? (
              <Pagination page={data.page} pageSize={data.pageSize} total={data.total} basePath="/dashboard/recalls" query={{ tab: tab === "today" ? undefined : tab, kind: query.kind, owner: query.owner, q: query.q, status: tab === "all" ? query.status : undefined }} className="border-t border-border" />
            ) : null}
          </Card>
        </>
      )}
    </div>
  );
}

/** The next open day's unconfirmed visits and the patients who asked for another time: calls about bookings, above the recalls. */
async function BookingCalls({ tenantId, timezone, canWrite }: { tenantId: string; timezone: string; canWrite: boolean }) {
  const rows = await listToConfirm(tenantId);
  return rows.length ? <ConfirmCalls rows={rows} timezone={timezone} canWrite={canWrite} /> : null;
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
const share = (n: number, of: number) => (of ? n / of : 0);
const asPct = (v: number) => `${Math.round(v * 100)}%`;
const egpTile = (v: number) => (Math.abs(v) >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M` : formatNumber(Math.round(v)));
const egp = (v: number) => `${formatNumber(Math.round(v))} EGP`;

/** How the recalls did: those due in the period, what is not booked, lapsed patients won back, revenue, endings, each person's part. */
async function ResultsTab({ tenantId, role, sp, timezone }: { tenantId: string; role: UserRole; sp: SearchParams; timezone: string }) {
  const period = resolvePeriod({ period: first(sp.period), from: first(sp.from), to: first(sp.to) }, timezone, new Date(), "month");
  const previous = { fromKey: dateKeyInTz(period.previous.from, timezone), toKey: dateKeyInTz(new Date(period.previous.to.getTime() - 1), timezone) };
  const r = await recallResults(tenantId, period, { withRevenue: can(role, "finance:read") });
  const d = r.due;
  const p = r.previousDue;
  const rate = (n: number, pn: number) => <DeltaChip current={share(n, d.count)} previous={p.count ? share(pn, p.count) : null} goodWhen="up" mode="points" format={asPct} />;
  const ended = r.ended.done + r.ended.declined + r.ended.unreachable;
  return (
    <div className="space-y-6">
      <PeriodPicker basePath="/dashboard/recalls" preset={period.preset} fromKey={period.fromKey} toKey={period.toKey} previous={previous} keep={{ tab: "results" }} />
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi label="Due" value={formatNumber(d.count)} hint={`Recalls due ${period.fromKey} → ${period.toKey}; ${formatNumber(p.count)} the period before`} />
        <Kpi label="Contacted" value={pct(d.contacted, d.count)} delta={rate(d.contacted, p.contacted)} hint={`${d.contacted} of ${d.count}, by the desk or an automatic message`} />
        <Kpi label="Booked" value={pct(d.booked, d.count)} tone="accent" delta={rate(d.booked, p.booked)} hint={`${d.booked} of ${d.count} booked a visit or came back`} />
        <Kpi label="Booked within 30 days" value={pct(d.bookedInTime, d.count)} delta={rate(d.bookedInTime, p.bookedInTime)} hint="Booked by 30 days after the due day" />
        <Kpi
          label="Accepted, not booked · EGP"
          value={egpTile(r.notBooked.value)}
          tone="warning"
          hint={`Waiting now: ${r.notBooked.planned} planned treatment${r.notBooked.planned === 1 ? "" : "s"}, ${r.notBooked.sessions} course session${r.notBooked.sessions === 1 ? "" : "s"}`}
        />
        <Kpi
          label="Lapsed patients won back"
          value={formatNumber(r.lapsed.wonBack)}
          delta={<DeltaChip current={r.lapsed.wonBack} previous={r.lapsed.previousWonBack} goodWhen="up" />}
          hint={`${r.lapsed.waiting} not seen for a year still to bring back`}
        />
        {r.revenue ? (
          <Kpi
            label="Revenue from recalls · EGP"
            value={egpTile(r.revenue.current)}
            tone="accent"
            delta={<DeltaChip current={r.revenue.current} previous={r.revenue.previous} goodWhen="up" format={egp} />}
            hint={`Charged at the ${r.revenue.visits} visit${r.revenue.visits === 1 ? "" : "s"} and sessions that ended a recall`}
          />
        ) : null}
        <Kpi label="Ended" value={formatNumber(ended)} hint={`${r.ended.done} came back, ${r.ended.declined} declined, ${r.ended.unreachable} unreachable`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <SectionTitle title="By kind" description="The recalls due in the period." />
          </div>
          {r.byKind.length ? (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Kind</TH>
                  <TH className="text-right">Due</TH>
                  <TH className="text-right">Contacted</TH>
                  <TH className="text-right">Booked</TH>
                </TR>
              </THead>
              <TBody>
                {r.byKind.map((k) => (
                  <TR key={k.kind}>
                    <TD className="font-medium">{k.label}</TD>
                    <TD className="text-right font-mono tabular-nums">{k.due}</TD>
                    <TD className="text-right font-mono tabular-nums">{k.contacted}</TD>
                    <TD className="text-right font-mono tabular-nums">
                      {k.booked} <span className="text-muted-foreground">({pct(k.booked, k.due)})</span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState title="Nothing was due in the period" hint="Pick a longer period above." />
            </div>
          )}
        </Card>

        <Card className="space-y-3">
          <SectionTitle title="How recalls ended" description="Recalls closed in the period." />
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="data-label">Came back</dt>
              <dd className="font-display text-2xl font-semibold tabular-nums text-success">{r.ended.done}</dd>
            </div>
            <div>
              <dt className="data-label">Declined</dt>
              <dd className="font-display text-2xl font-semibold tabular-nums">{r.ended.declined}</dd>
            </div>
            <div>
              <dt className="data-label">Unreachable</dt>
              <dd className="font-display text-2xl font-semibold tabular-nums">{r.ended.unreachable}</dd>
            </div>
          </dl>
          {r.ended.reasons.length ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Why patients declined">
              {r.ended.reasons.map((x) => (
                <Badge key={x.key}>
                  {x.label} · {x.count}
                </Badge>
              ))}
            </div>
          ) : null}
          {r.ended.endedAutomatically ? (
            <p className="text-xs text-muted-foreground">
              {r.ended.endedAutomatically} of the unreachable ended on their own: not booked {END_AFTER_WINDOW_DAYS} days after their window, with nothing done on them for {END_AFTER_SILENT_DAYS}.
            </p>
          ) : null}
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-4 py-3 sm:px-5">
          <SectionTitle title="By person" description="Calls, WhatsApp messages, visits booked from a recall, and endings recorded in the period." />
        </div>
        {r.byPerson.length ? (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Who</TH>
                  <TH className="text-right">Calls</TH>
                  <TH className="text-right">Messages</TH>
                  <TH className="text-right">Booked</TH>
                  <TH className="text-right">Declined</TH>
                  <TH className="text-right">Unreachable</TH>
                </TR>
              </THead>
              <TBody>
                {r.byPerson.map((x) => (
                  <TR key={x.id ?? "automatic"}>
                    <TD className={cn("font-medium", x.id === null && "text-muted-foreground")}>{x.name}</TD>
                    <TD className="text-right font-mono tabular-nums">{x.calls}</TD>
                    <TD className="text-right font-mono tabular-nums">{x.messages}</TD>
                    <TD className="text-right font-mono tabular-nums">{x.booked}</TD>
                    <TD className="text-right font-mono tabular-nums">{x.declined}</TD>
                    <TD className="text-right font-mono tabular-nums">{x.unreachable}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : (
          <div className="p-6">
            <EmptyState title="No recall work in the period" hint="Calls, messages and bookings from recalls are counted here." />
          </div>
        )}
      </Card>
    </div>
  );
}

async function RulesTab({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const [rules, treatments, staff] = await Promise.all([
    listRecallRules(tenantId),
    listTreatments(tenantId, { includeInactive: true }),
    db.user.findMany({ where: { tenantId, deletedAt: null, status: "ACTIVE", role: { in: ["RECEPTIONIST", "NURSE", "DOCTOR", "CLINIC_OWNER"] } }, orderBy: { fullName: "asc" }, select: { id: true, fullName: true, email: true } }),
  ]);
  return (
    <RecallRules
      rules={rules}
      treatments={treatments.map((t) => ({ id: t.id, name: t.name }))}
      staff={staff.map((u) => ({ id: u.id, name: u.fullName ?? u.email }))}
      canManage={canManage}
    />
  );
}
