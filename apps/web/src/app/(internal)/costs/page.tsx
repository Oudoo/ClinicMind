import { and, desc, eq, gte, sql as dsql } from "drizzle-orm";
import { db, costTracking, clients } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BarChart, DonutChart } from "@/components/charts/presets";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/utils";

/** Cost Tracking Dashboard — AI token spend per provider/feature/client. */
export default async function CostsPage() {
  const user = await requireTeamUser();
  const since = new Date(Date.now() - 30 * 86400_000);

  const [byFeature, byProvider, byClient, recent, totals] = await Promise.all([
    db
      .select({
        feature: costTracking.feature,
        cost: dsql<string>`SUM(${costTracking.costUsd})`,
        tokens: dsql<string>`SUM(${costTracking.inputTokens} + ${costTracking.outputTokens})`,
      })
      .from(costTracking)
      .where(and(eq(costTracking.tenantId, user.tenantId), gte(costTracking.createdAt, since)))
      .groupBy(costTracking.feature)
      .orderBy(desc(dsql`SUM(${costTracking.costUsd})`)),
    db
      .select({
        provider: costTracking.provider,
        cost: dsql<string>`SUM(${costTracking.costUsd})`,
      })
      .from(costTracking)
      .where(and(eq(costTracking.tenantId, user.tenantId), gte(costTracking.createdAt, since)))
      .groupBy(costTracking.provider),
    db
      .select({
        clientName: clients.name,
        cost: dsql<string>`SUM(${costTracking.costUsd})`,
      })
      .from(costTracking)
      .leftJoin(clients, eq(costTracking.clientId, clients.id))
      .where(and(eq(costTracking.tenantId, user.tenantId), gte(costTracking.createdAt, since)))
      .groupBy(clients.name)
      .orderBy(desc(dsql`SUM(${costTracking.costUsd})`))
      .limit(10),
    db
      .select()
      .from(costTracking)
      .where(eq(costTracking.tenantId, user.tenantId))
      .orderBy(desc(costTracking.createdAt))
      .limit(20),
    db
      .select({
        cost: dsql<string>`COALESCE(SUM(${costTracking.costUsd}), 0)`,
        tokens: dsql<string>`COALESCE(SUM(${costTracking.inputTokens} + ${costTracking.outputTokens}), 0)`,
        calls: dsql<string>`COUNT(*)`,
      })
      .from(costTracking)
      .where(and(eq(costTracking.tenantId, user.tenantId), gte(costTracking.createdAt, since))),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">AI Cost Tracking</h1>
        <p className="text-sm text-muted-foreground">
          Every OpenAI/Anthropic call attributed to tenant, client and feature — trailing 30 days.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="pt-5">
          <div className="text-sm text-muted-foreground">Total cost (30d)</div>
          <div className="text-2xl font-semibold">${Number(totals[0]?.cost ?? 0).toFixed(2)}</div>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <div className="text-sm text-muted-foreground">Tokens (30d)</div>
          <div className="text-2xl font-semibold">{formatNumber(totals[0]?.tokens ?? 0)}</div>
        </CardContent></Card>
        <Card><CardContent className="pt-5">
          <div className="text-sm text-muted-foreground">AI calls (30d)</div>
          <div className="text-2xl font-semibold">{formatNumber(totals[0]?.calls ?? 0)}</div>
        </CardContent></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Cost by feature</CardTitle></CardHeader>
          <CardContent>
            {byFeature.length > 0 ? (
              <BarChart
                horizontal
                categories={byFeature.map((f) => f.feature)}
                series={[{ name: "USD", data: byFeature.map((f) => Math.round(Number(f.cost) * 10000) / 10000) }]}
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">No AI usage yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Cost by provider</CardTitle></CardHeader>
          <CardContent>
            {byProvider.length > 0 ? (
              <DonutChart data={byProvider.map((p) => ({ name: p.provider, value: Number(p.cost) }))} />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">No AI usage yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Cost by client / project</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Client</TableHead><TableHead>Cost (30d)</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {byClient.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell>{c.clientName ?? "platform / unattributed"}</TableCell>
                    <TableCell>${Number(c.cost).toFixed(4)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Recent calls</CardTitle>
            <CardDescription>Latest 20 AI invocations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-xs">
                <span>{r.feature} · {r.model}</span>
                <span className="text-muted-foreground">
                  {formatNumber(r.inputTokens + r.outputTokens)} tok · ${Number(r.costUsd).toFixed(5)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
