import type { Metadata } from "next";
import Link from "next/link";
import { Phone } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can, canReadLabResults } from "@/lib/auth/rbac";
import { dateKeyInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { expenseFormContext } from "@/modules/finance/expenses";
import { LAB_VIEWS, type LabView } from "@/modules/lab/constants";
import { labKpis, listLabOrders, listLabs } from "@/modules/lab/orders";
import { Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { dayLabel } from "@/components/clinicmind/expense-shared";
import { LabStatusBadge } from "@/components/clinicmind/lab-shared";
import { BillLabOrderButton, NewLabOrderButton, RecordResultButton } from "@/components/clinicmind/lab-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lab work" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEW_LABELS: Record<LabView, string> = { late: "Late", waiting: "At the lab", back: "Back", unbilled: "Not billed", cancelled: "Cancelled" };
const EMPTY: Record<LabView, { title: string; hint: string }> = {
  late: { title: "Nothing late", hint: "An order still at the lab past its day shows here; the doctor who asked and the desk are told." },
  waiting: { title: "Nothing at the lab", hint: "Send an order from a patient's page, or with New lab order." },
  back: { title: "No result in the last 30 days", hint: "Results recorded in the last 30 days show here, the latest first." },
  unbilled: { title: "Every order is billed", hint: "An order shows here until the lab's bill for it is entered." },
  cancelled: { title: "Nothing cancelled", hint: "An order cancelled with a reason shows here." },
};

/**
 * `/dashboard/lab` — what the clinic has sent to labs (`lab:read`): what is
 * late (the doctor who asked and the desk are told), what is at the lab,
 * what came back, what is not billed yet and what was cancelled; the result
 * recorded by the clinicians, the lab's bill by the desk.
 */
export default async function LabPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "lab:read")) return <NotForRole title="Not available for your role" hint="Lab work is for the doctors, the nurses and the front desk." />;
  const kpis = await labKpis(ctx.tenantId, { role: ctx.role });
  const asked = first(sp.view);
  const view: LabView = asked && (LAB_VIEWS as readonly string[]).includes(asked) ? (asked as LabView) : kpis.late ? "late" : "waiting";
  const q = first(sp.q)?.trim() ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const canWrite = can(ctx.role, "lab:write");
  const clinician = canReadLabResults(ctx.role);
  const canBill = can(ctx.role, "expenses:write");
  const [list, form, labs] = await Promise.all([
    listLabOrders(ctx.tenantId, { view, q: q || undefined, page, pageSize: 25 }, { role: ctx.role }),
    canBill ? expenseFormContext(ctx.tenantId, { id: ctx.userId, role: ctx.role }) : null,
    canWrite ? listLabs(ctx.tenantId) : [],
  ]);
  const counts: Partial<Record<LabView, number>> = { late: kpis.late, waiting: kpis.waiting, unbilled: kpis.unbilled };
  const href = (v: LabView) => `/dashboard/lab?view=${v}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Lab work"
        description="Samples and tests sent to labs: from the procedure they came from, due back by the lab's usual days. A late one is told to the doctor who asked and to the desk."
        action={canWrite ? <NewLabOrderButton labs={labs} timezone={list.timezone} /> : undefined}
      />

      <Bento>
        <Metric label="Late" value={kpis.late} hint={kpis.late ? "Still at the lab past their day" : "Nothing late"} tone={kpis.late ? "warning" : "default"} />
        <Metric label="At the lab" value={kpis.waiting} hint="Not due back yet" />
        <Metric label="Back this week" value={kpis.backThisWeek} hint="Results in the last 7 days" tone="accent" />
        {clinician ? (
          <Metric label="To act on" value={kpis.flagged ?? 0} hint="Results of the last 30 days flagged for a doctor" tone={kpis.flagged ? "warning" : "default"} />
        ) : (
          <Metric label="Not billed" value={kpis.unbilled} hint="Orders with no lab bill entered yet" />
        )}
      </Bento>

      <nav aria-label="Lab lists" className="-mx-1 overflow-x-auto px-1">
        <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
          {LAB_VIEWS.map((v) => {
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
                  {count ? <span className={cn("rounded-md px-1.5 font-mono text-[10px]", v === "late" ? "bg-danger/10 text-danger" : "bg-card text-muted-foreground")}>{count}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Search lab orders">
          <input type="hidden" name="view" value={view} />
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={q} placeholder="Patient, what was asked, the lab or its no." />
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        {list.rows.length ? (
          <Table aria-label={VIEW_LABELS[view]} data-testid="lab-table">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Patient and what was asked</TH>
                <TH className="hidden md:table-cell">Sent</TH>
                <TH>{view === "back" ? "Came back" : view === "cancelled" ? "Why" : "Due back"}</TH>
                <TH className="hidden text-right sm:table-cell">Act</TH>
              </TR>
            </THead>
            <TBody>
              {list.rows.map((o) => {
                const actions = (
                  <>
                    {clinician && canWrite && o.status === "SENT" ? <RecordResultButton order={o} timezone={list.timezone} /> : null}
                    {view === "late" && o.lab.phone ? (
                      <a href={`tel:${o.lab.phone.replace(/\s+/g, "")}`} className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted" aria-label={`Call ${o.lab.name}`}>
                        <Phone className="h-4 w-4" aria-hidden="true" />
                        Call the lab
                      </a>
                    ) : null}
                    {canBill && form && !o.bill && o.status !== "CANCELLED" && view === "unbilled" ? <BillLabOrderButton order={o} timezone={list.timezone} drawerOpen={form.drawerOpen} /> : null}
                  </>
                );
                return (
                  <TR key={o.id}>
                    <TD>
                      <Link href={`/dashboard/patients/${o.patient.id}`} className="font-medium underline-offset-2 hover:underline">
                        {o.patient.fullName}
                      </Link>
                      <div className="text-sm">
                        <Link href={`/dashboard/lab/${o.id}`} className="underline-offset-2 hover:underline">
                          {o.tests}
                        </Link>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {o.lab.name}
                        {o.site ? ` · ${o.site}` : ""}
                        {o.doctor ? ` · ${o.doctor.fullName}` : ""}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1 sm:hidden">{actions}</div>
                    </TD>
                    <TD className="hidden whitespace-nowrap text-xs md:table-cell">{dayLabel(o.sentOn)}</TD>
                    <TD className="text-xs">
                      {view === "cancelled" ? (
                        <span className="block max-w-[16rem]">{o.cancelReason}</span>
                      ) : (
                        <div className="space-y-1">
                          <LabStatusBadge order={o} />
                          <div className="whitespace-nowrap text-muted-foreground">
                            {o.status === "RECEIVED" && o.receivedAt ? `Back on ${dayLabel(dateKeyInTz(new Date(o.receivedAt), list.timezone))}` : `${o.late ? "Was due" : "By"} ${dayLabel(o.dueOn)}`}
                          </div>
                        </div>
                      )}
                    </TD>
                    <TD className="hidden text-right sm:table-cell">
                      <div className="flex flex-col items-end gap-1 lg:flex-row lg:justify-end">{actions}</div>
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title={q ? "No order matches" : EMPTY[view].title} hint={q ? "Try another name or another list." : EMPTY[view].hint} />
          </div>
        )}
        {list.total > list.pageSize ? <Pagination page={page} pageSize={list.pageSize} total={list.total} basePath="/dashboard/lab" query={{ view, q: q || undefined }} className="border-t border-border" /> : null}
      </Card>
    </div>
  );
}
