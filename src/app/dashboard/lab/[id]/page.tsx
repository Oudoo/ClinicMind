import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Phone } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can, canReadLabResults } from "@/lib/auth/rbac";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { expenseFormContext } from "@/modules/finance/expenses";
import { FinanceError } from "@/modules/finance/errors";
import { getLabOrder, labOrderOptions } from "@/modules/lab/orders";
import { Badge, Card } from "@/components/ui/primitives";
import { Alert } from "@/components/ui/field";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { dayLabel } from "@/components/clinicmind/expense-shared";
import { LabStatusBadge } from "@/components/clinicmind/lab-shared";
import { BillLabOrderButton, CancelLabOrderButton, EditLabOrderButton, LabFileList, RecordResultButton } from "@/components/clinicmind/lab-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Lab order" };

/**
 * `/dashboard/lab/[id]` — one lab order: for whom, what was asked and where
 * from, its procedure and its doctor, when it went and when it is due back;
 * its result and the lab's report (the clinicians), and the lab's bill.
 */
export default async function LabOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "lab:read")) return <NotForRole title="Not available for your role" hint="Lab work is for the doctors, the nurses and the front desk." />;
  const order = await getLabOrder(ctx.tenantId, id, { role: ctx.role }).catch((err: unknown) => {
    if (err instanceof FinanceError && err.status === 404) return null;
    throw err;
  });
  if (!order) notFound();
  const canWrite = can(ctx.role, "lab:write");
  const clinician = canReadLabResults(ctx.role);
  const canBill = can(ctx.role, "expenses:write");
  const [options, form, tz] = await Promise.all([
    canWrite && order.status === "SENT" ? labOrderOptions(ctx.tenantId, order.patient.id) : null,
    canBill ? expenseFormContext(ctx.tenantId, { id: ctx.userId, role: ctx.role }) : null,
    getTenantTimezone(ctx.tenantId),
  ]);
  const when = (iso: string) => formatDateInTz(new Date(iso), tz, { day: "numeric", month: "short", year: "numeric" });
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-dashed border-border py-1.5 last:border-0">
      <dt className="data-label">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="lab-order-page">
      <Link href="/dashboard/lab" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Lab work
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold tracking-tight">{order.tests}</h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link href={`/dashboard/patients/${order.patient.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
              {order.patient.fullName}
            </Link>
            · {order.lab.name}
            <LabStatusBadge order={order} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {clinician && canWrite && order.status !== "CANCELLED" ? <RecordResultButton order={order} timezone={tz} variant={order.status === "SENT" ? "primary" : "outline"} /> : null}
          {canWrite && order.status === "SENT" && options ? <EditLabOrderButton order={order} procedures={options.procedures} timezone={tz} /> : null}
          {canWrite && order.status === "SENT" && !order.bill ? <CancelLabOrderButton order={order} /> : null}
        </div>
      </div>

      {order.cancelledAt ? (
        <Alert tone="info">
          Cancelled {when(order.cancelledAt)}: {order.cancelReason}
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <dl>
            {row("Where on the body", order.site ?? "—")}
            {row(
              "From the procedure",
              order.procedure ? `${order.procedure.label}, ${formatDateInTz(new Date(order.procedure.performedAt), tz, { day: "numeric", month: "short" })}` : "None",
            )}
            {row("Asked by", order.doctor?.fullName ?? "—")}
            {row("Sent", dayLabel(order.sentOn))}
            {row("Due back", order.status === "SENT" ? `${dayLabel(order.dueOn)}${order.late ? ` (${order.daysLate} day${order.daysLate === 1 ? "" : "s"} late)` : ""}` : dayLabel(order.dueOn))}
            {order.reference ? row("The lab's no.", <span className="font-mono">{order.reference}</span>) : null}
            {row(
              "The lab",
              <span className="inline-flex flex-wrap items-center gap-2">
                {order.lab.name}
                {order.lab.phone ? (
                  <a href={`tel:${order.lab.phone.replace(/\s+/g, "")}`} className="inline-flex items-center gap-1 text-accent underline-offset-2 hover:underline">
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    {order.lab.phone}
                  </a>
                ) : null}
              </span>,
            )}
            {order.note ? row("Note", <span className="whitespace-pre-line">{order.note}</span>) : null}
            {row("Recorded", `${when(order.createdAt)}${order.createdBy ? ` by ${order.createdBy}` : ""}`)}
          </dl>
        </Card>
        <Card className="space-y-2" aria-label="The lab's bill">
          <h3 className="font-display text-base font-semibold">The lab&apos;s bill</h3>
          {order.bill ? (
            <>
              <p className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-muted-foreground">Amount</span>
                <span className="font-mono tabular-nums">{formatNumber(order.bill.amount)} EGP</span>
              </p>
              <p className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-muted-foreground">{order.bill.owed ? "Owed to the lab" : "Paid"}</span>
                <span className="font-mono tabular-nums">{formatNumber(order.bill.owed || order.bill.paid)}</span>
              </p>
              {canBill ? (
                <Link href={`/dashboard/finance/expenses/${order.bill.expenseId}`} className="text-sm text-accent underline-offset-2 hover:underline">
                  Open the expense
                </Link>
              ) : null}
              {order.procedure ? <p className="text-xs text-muted-foreground">It comes off the doctor&apos;s share of the procedure.</p> : null}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{order.billVoided ? "Its bill was voided: enter it again." : "Not billed yet."}</p>
              {canBill && form && order.status !== "CANCELLED" ? <BillLabOrderButton order={order} timezone={tz} drawerOpen={form.drawerOpen} /> : null}
            </>
          )}
        </Card>
      </div>

      <Card className="space-y-3" aria-label="The result">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-base font-semibold">The result</h3>
          {order.abnormal ? <Badge tone="warning">A doctor must act on it</Badge> : null}
        </div>
        {order.status !== "RECEIVED" ? (
          <p className="text-sm text-muted-foreground">{order.status === "CANCELLED" ? "None: the order was cancelled." : "Not back yet."}</p>
        ) : clinician ? (
          <>
            <p className="whitespace-pre-line text-sm" data-testid="lab-result">
              {order.result}
            </p>
            <p className="text-xs text-muted-foreground">
              Came back on {order.receivedAt ? when(order.receivedAt) : ""}
              {order.receivedBy ? `, recorded by ${order.receivedBy}` : ""}
            </p>
            <LabFileList files={order.files} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">The result is in, for the doctors and the nurses to read.</p>
        )}
      </Card>
    </div>
  );
}
