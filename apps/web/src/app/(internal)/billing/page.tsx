import { desc, eq } from "drizzle-orm";
import { db, plans, subscriptions, invoices, usageRecords } from "@growengine/db";
import { sql as dsql, and } from "drizzle-orm";
import { requirePermission } from "@/lib/session";
import { generateInvoice } from "@/app/actions/admin";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatNumber , formAction } from "@/lib/utils";

export default async function BillingPage() {
  const user = await requirePermission("billing:read");
  const [sub] = await db
    .select({ subscription: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(subscriptions.planId, plans.id))
    .where(eq(subscriptions.tenantId, user.tenantId))
    .limit(1);

  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.tenantId, user.tenantId))
    .orderBy(desc(invoices.createdAt))
    .limit(20);

  const usage = await db
    .select({
      meter: usageRecords.meter,
      total: dsql<string>`SUM(${usageRecords.quantity})`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.tenantId, user.tenantId),
        dsql`${usageRecords.usageDate} >= ${sub?.subscription.currentPeriodStart ?? "1970-01-01"}`
      )
    )
    .groupBy(usageRecords.meter);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Billing & Subscription</h1>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Current plan</CardTitle>
          </CardHeader>
          <CardContent>
            {sub ? (
              <>
                <div className="text-2xl font-bold">{sub.plan.name}</div>
                <div className="text-muted-foreground">{formatCurrency(sub.plan.monthlyPrice)}/month</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant={statusVariant(sub.subscription.status)}>{sub.subscription.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {sub.subscription.currentPeriodStart} → {sub.subscription.currentPeriodEnd}
                  </span>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No subscription record.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Usage this period</CardTitle>
            <CardDescription>Metered consumption — AI tokens, API calls, syncs, transcription.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {usage.map((u) => (
                <div key={u.meter} className="rounded-md border p-3">
                  <div className="text-xs text-muted-foreground">{u.meter.replace(/_/g, " ")}</div>
                  <div className="text-xl font-semibold">{formatNumber(u.total)}</div>
                </div>
              ))}
              {usage.length === 0 && (
                <p className="col-span-4 py-4 text-center text-sm text-muted-foreground">No usage recorded yet.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Invoices</CardTitle>
          <form action={formAction(generateInvoice)}>
            <Button variant="outline">Generate period invoice</Button>
          </form>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoiceRows.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="font-mono text-sm">{inv.number}</TableCell>
                  <TableCell><Badge variant={statusVariant(inv.status)}>{inv.status}</Badge></TableCell>
                  <TableCell>{formatCurrency(inv.total, inv.currency)}</TableCell>
                  <TableCell>{inv.issuedAt?.toISOString().slice(0, 10) ?? "—"}</TableCell>
                  <TableCell>{inv.dueAt?.toISOString().slice(0, 10) ?? "—"}</TableCell>
                </TableRow>
              ))}
              {invoiceRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No invoices yet.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
