import Link from "next/link";
import type { Metadata } from "next";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { cn } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import { RECALL_KIND_LABEL, RECALL_KINDS, RECALL_STATUS_LABEL, RECALL_STATUSES } from "@/modules/recalls/constants";
import { listRecallRules } from "@/modules/recalls/rules";
import { listRecalls } from "@/modules/recalls/service";
import type { RecallTab } from "@/modules/recalls/dto";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { RecallList } from "@/components/clinicmind/recall-list";
import { RecallRules } from "@/components/clinicmind/recall-rules";
import { ConfirmCalls } from "@/components/clinicmind/confirm-calls";
import { listToConfirm } from "@/modules/appointments/reminders";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Recalls" };

type SearchParams = Record<string, string | string[] | undefined>;
type Tab = RecallTab | "rules";
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const TABS: { key: Tab; label: string; short?: string }[] = [
  { key: "today", label: "Contact today", short: "Today" },
  { key: "soon", label: "Due soon" },
  { key: "booked", label: "Booked" },
  { key: "all", label: "All" },
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
 * and the rules that make them.
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
      tab: tab === "rules" ? "today" : tab,
      kind: query.kind && (RECALL_KINDS as readonly string[]).includes(query.kind) ? (query.kind as (typeof RECALL_KINDS)[number]) : undefined,
      owner: query.owner === "mine" ? "mine" : "all",
      q: query.q,
      status: tab === "all" && query.status && [...RECALL_STATUSES, "active", "closed"].includes(query.status) ? (query.status as (typeof RECALL_STATUSES)[number]) : undefined,
      page: Number(first(sp.page) ?? 1) || 1,
      pageSize: tab === "rules" ? 1 : 25,
    },
    viewer,
  );
  const badges: Partial<Record<Tab, number>> = { today: data.counts.today, soon: data.counts.soon, booked: data.counts.booked };
  const href = (t: Tab) => {
    const params = new URLSearchParams();
    if (t !== "today") params.set("tab", t);
    if (t !== "rules") for (const [k, v] of Object.entries({ kind: query.kind, owner: query.owner, q: query.q })) if (v) params.set(k, v);
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
            <RecallList recalls={data.recalls} timezone={timezone} canWrite={can(ctx.role, "recalls:write")} empty={EMPTY[tab]} />
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
