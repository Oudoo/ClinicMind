import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listInvoices } from "@/modules/finance/invoices";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { NotForRole } from "@/components/clinicmind/report-shared";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invoices" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "default" },
  ISSUED: { label: "Issued", tone: "warning" },
  PART_PAID: { label: "Part-paid", tone: "accent" },
  PAID: { label: "Paid", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};
const FILTERS = [
  ["", "All"],
  ["OPEN", "To be paid"],
  ["PAID", "Paid"],
  ["DRAFT", "Drafts"],
  ["CANCELLED", "Cancelled"],
] as const;

/** `/dashboard/finance/invoices` — every invoice, newest first: number, patient, total, paid and status. */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="Invoices are for the front desk and the clinic owner." />;
  }
  const status = first(sp.status) ?? "";
  const q = first(sp.q) ?? "";
  const page = Math.max(1, Number(first(sp.page)) || 1);
  const [list, timezone] = await Promise.all([
    listInvoices(ctx.tenantId, { status: FILTERS.some(([v]) => v === status) && status ? status : undefined, q: q || undefined, page, pageSize: 25 }),
    getTenantTimezone(ctx.tenantId),
  ]);
  const day = (iso: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="space-y-6">
      <SectionTitle title="Invoices" description="Numbered when issued, per branch and without gaps. Make one from a patient's page: it bills their unbilled charges." />
      <Card className="overflow-hidden p-0">
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-border p-4" role="search" aria-label="Filter invoices">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input name="q" defaultValue={q} placeholder="Number or patient" />
          </label>
          <label className="flex w-full flex-col gap-1 text-xs text-muted-foreground sm:w-44">
            Status
            <Select name="status" defaultValue={status}>
              {FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" variant="outline">
            Apply
          </Button>
        </form>
        {list.invoices.length ? (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Invoice</TH>
                <TH className="hidden sm:table-cell">Patient</TH>
                <TH className="text-right">Total</TH>
                <TH className="hidden text-right md:table-cell">Paid</TH>
                <TH className="text-right">Status</TH>
              </TR>
            </THead>
            <TBody>
              {list.invoices.map((inv) => (
                <TR key={inv.id}>
                  <TD>
                    <Link href={`/dashboard/finance/invoices/${inv.id}`} className="font-mono text-xs font-medium underline-offset-2 hover:underline">
                      {inv.number ?? "Draft"}
                    </Link>
                    <div className="text-xs text-muted-foreground">{day(inv.issuedAt ?? inv.createdAt)}</div>
                    <div className="text-xs sm:hidden">{inv.patientName}</div>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <Link href={`/dashboard/patients/${inv.patientId}`} className="underline-offset-2 hover:underline">
                      {inv.patientName}
                    </Link>
                  </TD>
                  <TD className="whitespace-nowrap text-right font-mono tabular-nums">{formatNumber(inv.total)}</TD>
                  <TD className="hidden whitespace-nowrap text-right font-mono tabular-nums md:table-cell">{inv.status === "DRAFT" ? "—" : formatNumber(inv.paid)}</TD>
                  <TD className="text-right">
                    {inv.status === "PAID" && inv.writtenOff > 0 ? (
                      <Badge tone="default" title={`${formatNumber(inv.writtenOff)} EGP written off`}>
                        Written off
                      </Badge>
                    ) : (
                      <Badge tone={STATUS[inv.status]?.tone ?? "default"}>{STATUS[inv.status]?.label ?? inv.status}</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title={status || q ? "No invoice matches" : "No invoices yet"} hint="Make one from a patient's page: Procedures & payments → Invoice the unbilled charges." />
          </div>
        )}
      </Card>
      {list.total > list.pageSize ? <Pagination page={page} pageSize={list.pageSize} total={list.total} basePath="/dashboard/finance/invoices" query={{ status, q }} /> : null}
    </div>
  );
}
