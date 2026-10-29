import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { INSTALMENT_VIEWS, instalmentKpis, listPlans, type InstalmentView } from "@/modules/finance/instalments";
import { INSTALMENT_STATE_LABELS } from "@/modules/finance/instalment-schedule";
import { Badge, Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { PayPlanButton, RemindPlanButton } from "@/components/clinicmind/instalment-plan-list";
import { INSTALMENT_TONE, instalmentName } from "@/components/clinicmind/instalment-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Instalments" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEW_LABELS: Record<InstalmentView, string> = { overdue: "Overdue", due: "Due this week", active: "Active", completed: "Paid in full", cancelled: "Stopped" };
const EMPTY: Record<InstalmentView, { title: string; hint: string }> = {
  overdue: { title: "Nothing overdue", hint: "A plan shows here once an instalment's day has passed and it is not paid in full." },
  due: { title: "Nothing falls due this week", hint: "Plans with an instalment due in the next 7 days show here." },
  active: { title: "No active plan", hint: "Make one from a patient's page, or from an accepted treatment plan: Pay in instalments." },
  completed: { title: "No plan paid in full yet", hint: "A plan shows here once its last instalment is paid." },
  cancelled: { title: "No plan was stopped", hint: "A plan stopped with a reason shows here." },
};

/**
 * `/dashboard/finance/instalments` — treatment paid over time, for the front
 * desk (`payments:write`) and the owner (`finance:read`): what is overdue,
 * what falls due this week, what the active plans still have to pay and what
 * was paid towards them this month; then the plans by view, each with its
 * next instalment and the last reminder, a payment towards it and a reminder
 * now for the desk.
 */
export default async function InstalmentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="Instalment plans are for the front desk and the clinic owner." />;
  }
  const kpis = await instalmentKpis(ctx.tenantId);
  const asked = first(sp.view);
  // Without a choice: what needs the desk first.
  const view: InstalmentView = asked && (INSTALMENT_VIEWS as readonly string[]).includes(asked) ? (asked as InstalmentView) : kpis.overdue.plans ? "overdue" : kpis.dueThisWeek.plans ? "due" : "active";
  const q = first(sp.q)?.trim() ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const list = await listPlans(ctx.tenantId, { view, q: q || undefined, page, pageSize: 25 });
  const { timezone } = list;
  const day = (key: string) => formatDateInTz(new Date(`${key}T12:00:00Z`), timezone, { day: "numeric", month: "short", year: "numeric" });
  const when = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short" });
  const canPay = can(ctx.role, "payments:write");
  // A payment and a reminder now on the open plans' rows: beside them on a wide screen, under the name on a phone.
  const canAct = canPay && view !== "completed" && view !== "cancelled";
  const canRefund = can(ctx.role, "tenant:manage");
  const counts: Partial<Record<InstalmentView, number>> = { overdue: kpis.overdue.plans, due: kpis.dueThisWeek.plans, active: kpis.active.plans };
  const href = (v: InstalmentView) => `/dashboard/finance/instalments?view=${v}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Instalments"
        description="Treatment paid over time. Payments recorded towards a plan cover its instalments in order; the patient gets a WhatsApp reminder before each one and a message the day after one is missed."
      />

      <Bento>
        <Metric label="Overdue · EGP" value={formatNumber(kpis.overdue.amount)} hint={kpis.overdue.plans ? `On ${plural(kpis.overdue.plans, "plan")}` : "Nothing overdue"} tone={kpis.overdue.amount ? "warning" : "default"} />
        <Metric label="Due this week · EGP" value={formatNumber(kpis.dueThisWeek.amount)} hint={kpis.dueThisWeek.plans ? `On ${plural(kpis.dueThisWeek.plans, "plan")}, in the next 7 days` : "Nothing in the next 7 days"} />
        <Metric label="Still to collect · EGP" value={formatNumber(kpis.active.left)} hint={`On ${plural(kpis.active.plans, "active plan")}`} tone="accent" />
        <Metric label="Paid this month · EGP" value={formatNumber(kpis.collectedThisMonth)} hint="Towards instalment plans, since the 1st" />
      </Bento>

      <nav aria-label="Instalment lists" className="-mx-1 overflow-x-auto px-1">
        <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
          {INSTALMENT_VIEWS.map((v) => {
            const current = v === view;
            const count = counts[v];
            return (
              <li key={v}>
                <Link
                  href={href(v)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                    current ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEW_LABELS[v]}
                  {count ? <span className={cn("rounded-md px-1.5 font-mono text-[10px]", v === "overdue" ? "bg-danger/10 text-danger" : "bg-card text-muted-foreground")}>{count}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Search instalment plans">
          <input type="hidden" name="view" value={view} />
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={q} placeholder="Patient or what the plan pays for" />
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {list.plans.length ? (
          <Table aria-label={VIEW_LABELS[view]} data-testid="instalment-table">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Patient and plan</TH>
                <TH className="hidden text-right sm:table-cell">Paid</TH>
                <TH>{view === "completed" || view === "cancelled" ? "Ended" : "Next"}</TH>
                <TH className="hidden lg:table-cell">Last reminder</TH>
                {canAct ? <TH className="hidden text-right sm:table-cell">Act</TH> : null}
              </TR>
            </THead>
            <TBody>
              {list.plans.map((p) => {
                const next = view === "due" ? p.dueThisWeek : p.position.next;
                const share = p.total ? Math.min(100, Math.round((p.position.paid * 100) / p.total)) : 0;
                const actions = (
                  <>
                    <PayPlanButton planId={p.id} patient={{ id: p.patient.id, fullName: p.patient.fullName }} owed={p.position.next?.owed} timezone={timezone} canRefund={canRefund} />
                    <RemindPlanButton planId={p.id} patientName={p.patient.fullName} consent={p.patient.reminderConsent} />
                  </>
                );
                return (
                  <TR key={p.id}>
                    <TD>
                      <Link href={`/dashboard/patients/${p.patient.id}`} className="font-medium underline-offset-2 hover:underline">
                        {p.patient.fullName}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {p.title}
                        {p.quote?.number ? (
                          <>
                            {" · "}
                            <span className="whitespace-nowrap font-mono">{p.quote.number}</span>
                          </>
                        ) : null}
                      </div>
                      <div className="text-xs tabular-nums sm:hidden">
                        {formatNumber(p.position.paid)} of {formatNumber(p.total)} EGP paid
                      </div>
                      {canAct ? <div className="mt-2 flex flex-wrap gap-1 sm:hidden">{actions}</div> : null}
                    </TD>
                    <TD className="hidden whitespace-nowrap text-right sm:table-cell">
                      <span className="font-mono tabular-nums">{formatNumber(p.position.paid)}</span>
                      <span className="text-xs text-muted-foreground"> / {formatNumber(p.total)}</span>
                      <div className="ml-auto mt-1 h-1 w-24 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
                      </div>
                    </TD>
                    <TD className="text-xs">
                      {p.status === "COMPLETED" ? (
                        <Badge tone="success">Paid in full</Badge>
                      ) : p.status === "CANCELLED" ? (
                        <Badge>Stopped</Badge>
                      ) : next ? (
                        <div className="space-y-1">
                          <Badge tone={INSTALMENT_TONE[next.state]}>{next.state === "OVERDUE" ? `${next.daysLate} days late` : INSTALMENT_STATE_LABELS[next.state]}</Badge>
                          <div>
                            {instalmentName(next.number)} · <span className="whitespace-nowrap font-mono tabular-nums">{formatNumber(next.owed)} EGP</span>
                          </div>
                          <div className="whitespace-nowrap text-muted-foreground">{next.state === "OVERDUE" ? `Was due ${day(next.dueKey)}` : `Due ${day(next.dueKey)}`}</div>
                          {view === "overdue" && p.position.overdue > next.owed ? <div className="text-danger">{formatNumber(p.position.overdue)} EGP overdue in all</div> : null}
                        </div>
                      ) : (
                        "—"
                      )}
                    </TD>
                    <TD className="hidden text-xs text-muted-foreground lg:table-cell">
                      {p.lastReminderAt ? when(p.lastReminderAt) : "None yet"}
                      {p.patient.reminderConsent ? null : <div>No reminders (asked)</div>}
                    </TD>
                    {canAct ? (
                      <TD className="hidden text-right sm:table-cell">
                        <div className="flex flex-col items-end gap-1 lg:flex-row lg:justify-end">{actions}</div>
                      </TD>
                    ) : null}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title={q ? "No plan matches" : EMPTY[view].title} hint={q ? "Try another name, or another list above." : EMPTY[view].hint} />
          </div>
        )}
        {list.total > list.pageSize ? <Pagination page={page} pageSize={list.pageSize} total={list.total} basePath="/dashboard/finance/instalments" query={{ view, q: q || undefined }} className="border-t border-border" /> : null}
      </Card>
    </div>
  );
}
