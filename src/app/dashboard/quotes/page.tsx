import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz, fromDateKey } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { listQuotes, QUOTE_LIST_STATES } from "@/modules/quotes/service";
import { ACCEPTANCE_PERIODS, caseAcceptance } from "@/modules/quotes/acceptance";
import { QUOTE_STATE_LABELS, rate } from "@/modules/quotes/constants";
import { Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { QuoteStateBadge } from "@/components/clinicmind/quote-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Treatment plans" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const FILTERS: [string, string][] = [["", "All"], ...QUOTE_LIST_STATES.map((s): [string, string] => [s, QUOTE_STATE_LABELS[s]])];

/**
 * `/dashboard/quotes` — treatment plans and quotes: how many given in the
 * period were accepted (by value and by plan), what waits for an answer and
 * what expires this week, every quote newest first, and acceptance by doctor
 * (the owner) and by treatment.
 */
export default async function QuotesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "quotes:read")) {
    return <NotForRole title="Not available for your role" hint="Treatment plans are for the doctors, the front desk and the clinic owner." />;
  }
  const state = first(sp.state) ?? "";
  const q = first(sp.q) ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const asked = Number(first(sp.days));
  const days = (ACCEPTANCE_PERIODS as readonly number[]).includes(asked) ? asked : 90;
  const [list, acceptance] = await Promise.all([
    listQuotes(ctx.tenantId, { state: FILTERS.some(([v]) => v === state) && state ? state : undefined, q: q || undefined, page, pageSize: 25 }),
    caseAcceptance(ctx.tenantId, { days, byDoctor: can(ctx.role, "finance:read") }),
  ]);
  const timezone = list.timezone;
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });
  const dayOfKey = (key: string) => day((fromDateKey(key, timezone) ?? new Date()).toISOString());
  const a = acceptance;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Treatment plans"
        description="Quotes given to patients, printed or on WhatsApp, and what became of them. Accepted treatments become planned procedures."
        action={
          can(ctx.role, "quotes:write") ? (
            <Button asChild size="sm">
              <Link href="/dashboard/quotes/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                New treatment plan
              </Link>
            </Button>
          ) : null
        }
      />

      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Period">
        <label className="space-y-1.5">
          <span className="data-label block">Given in the last</span>
          <Select name="days" defaultValue={String(days)} className="w-40">
            {ACCEPTANCE_PERIODS.map((d) => (
              <option key={d} value={d}>
                {d === 365 ? "12 months" : `${d} days`}
              </option>
            ))}
          </Select>
        </label>
        {state ? <input type="hidden" name="state" value={state} /> : null}
        <Button type="submit" variant="outline" size="sm" className="h-10">
          Show
        </Button>
      </form>

      <Bento>
        <Metric label="Case acceptance (value)" value={rate(a.acceptedValue, a.presentedValue)} hint={`${formatNumber(a.acceptedValue)} of ${formatNumber(a.presentedValue)} EGP given`} tone="accent" />
        <Metric label="Plans accepted" value={rate(a.accepted, a.presented)} hint={`${a.accepted} of ${a.presented} · ${a.declined} declined · ${a.expired} expired`} />
        <Metric label="Waiting for an answer" value={a.open} hint={a.presented ? `of the ${a.presented} given in the period` : "Nothing given in the period"} />
        <Metric label="Expiring within a week" value={a.expiringSoon.count} hint={`${formatNumber(a.expiringSoon.value)} EGP still open`} tone={a.expiringSoon.count ? "warning" : "default"} />
      </Bento>

      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Filter treatment plans">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={q} placeholder="Number, heading or patient" />
          </label>
          <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground sm:w-52">
            Status
            <Select name="state" defaultValue={state}>
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <input type="hidden" name="days" value={days} />
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>
        {list.quotes.length ? (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Plan</TH>
                <TH className="hidden sm:table-cell">Patient</TH>
                <TH className="hidden md:table-cell">Doctor</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right">Status</TH>
              </TR>
            </THead>
            <TBody>
              {list.quotes.map((row) => (
                <TR key={row.id}>
                  <TD>
                    <Link href={`/dashboard/quotes/${row.id}`} className="font-mono text-xs font-medium underline-offset-2 hover:underline">
                      {row.number ?? "Draft"}
                    </Link>
                    <div className="text-xs text-muted-foreground">{row.title ?? "Treatment plan"} · {day(row.sentAt ?? row.createdAt)}</div>
                    <div className="text-xs sm:hidden">{row.patientName}</div>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <Link href={`/dashboard/patients/${row.patientId}`} className="underline-offset-2 hover:underline">
                      {row.patientName}
                    </Link>
                  </TD>
                  <TD className="hidden text-muted-foreground md:table-cell">{row.doctorName ?? "—"}</TD>
                  <TD className="whitespace-nowrap text-right font-mono tabular-nums">
                    {formatNumber(row.total)}
                    {row.state === "ACCEPTED" && row.acceptedTotal !== null && row.acceptedTotal !== row.total ? <div className="text-[11px] text-success">{formatNumber(row.acceptedTotal)} accepted</div> : null}
                  </TD>
                  <TD className="text-right">
                    <QuoteStateBadge state={row.state} />
                    {row.state === "SENT" ? <div className="mt-0.5 text-[11px] text-muted-foreground">until {dayOfKey(row.validUntilKey)}</div> : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title={state || q ? "No plan matches" : "No treatment plans yet"} hint="Make one from a patient's page, or with New treatment plan." />
          </div>
        )}
      </Card>
      {list.total > list.pageSize ? <Pagination page={page} pageSize={list.pageSize} total={list.total} basePath="/dashboard/quotes" query={{ state, q, days: String(days) }} /> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {a.byDoctor ? (
          <Card className="space-y-3">
            <SectionTitle title="By doctor" description="Plans given in the period, by the doctor who proposed them." />
            {a.byDoctor.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Doctor</TH>
                      <TH className="text-right">Given</TH>
                      <TH className="text-right">Accepted</TH>
                      <TH className="text-right">By value</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {a.byDoctor.map((d) => (
                      <TR key={d.doctorId ?? "none"}>
                        <TD>{d.name}</TD>
                        <TD className="text-right tabular-nums">{d.presented}</TD>
                        <TD className="text-right tabular-nums">
                          {d.accepted} <span className="text-xs text-muted-foreground">({rate(d.accepted, d.presented)})</span>
                        </TD>
                        <TD className="whitespace-nowrap text-right tabular-nums">
                          {rate(d.acceptedValue, d.presentedValue)} <span className="text-xs text-muted-foreground">of {formatNumber(d.presentedValue)}</span>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="No plan given in the period" />
            )}
          </Card>
        ) : null}
        <Card className="space-y-3">
          <SectionTitle title="By treatment" description="Each treatment quoted in the period, and how much of it was accepted." />
          {a.byTreatment.length ? (
            <ul className="space-y-1 text-sm">
              {a.byTreatment.map((t) => (
                <li key={t.treatmentId} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0">{t.name}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {rate(t.acceptedValue, t.presentedValue)} of {formatNumber(t.presentedValue)} EGP
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No treatment quoted in the period" />
          )}
        </Card>
      </div>
    </div>
  );
}
