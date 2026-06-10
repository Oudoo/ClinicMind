import Link from "next/link";
import { and, eq, desc, gte, sql as dsql } from "drizzle-orm";
import {
  db,
  clients,
  metricRecords,
  integrations,
  healthScores,
  recommendations,
  tickets,
  aiJobs,
} from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { KpiCard } from "@/components/kpi-card";
import { TimeSeriesChart, DonutChart } from "@/components/charts/presets";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/utils";

export default async function DashboardPage() {
  const user = await requireTeamUser();
  const tenantId = user.tenantId;
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const since60 = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);

  // Tenant-wide KPI aggregates (current vs prior 30 days)
  const kpis = await db
    .select({
      metric: metricRecords.metric,
      current: dsql<string>`SUM(CASE WHEN ${metricRecords.date} >= ${since30} THEN ${metricRecords.value} ELSE 0 END)`,
      previous: dsql<string>`SUM(CASE WHEN ${metricRecords.date} < ${since30} THEN ${metricRecords.value} ELSE 0 END)`,
      requestIds: dsql<string>`COUNT(DISTINCT ${metricRecords.sourceRequestId})`,
    })
    .from(metricRecords)
    .where(and(eq(metricRecords.tenantId, tenantId), gte(metricRecords.date, since60)))
    .groupBy(metricRecords.metric);

  const kpiMap = new Map(kpis.map((k) => [k.metric, k]));
  const delta = (m?: { current: string; previous: string }) => {
    if (!m || Number(m.previous) === 0) return null;
    return ((Number(m.current) - Number(m.previous)) / Number(m.previous)) * 100;
  };
  const trace = (m?: { requestIds: string }) =>
    m ? `verified · ${m.requestIds} API request ids traced` : undefined;

  // Daily spend/revenue series
  const daily = await db
    .select({
      date: metricRecords.date,
      metric: metricRecords.metric,
      value: dsql<string>`SUM(${metricRecords.value})`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, tenantId),
        gte(metricRecords.date, since30),
        dsql`${metricRecords.metric} IN ('spend','revenue','conversions')`
      )
    )
    .groupBy(metricRecords.date, metricRecords.metric)
    .orderBy(metricRecords.date);

  const seriesFor = (metric: string): [string, number][] =>
    daily.filter((d) => d.metric === metric).map((d) => [d.date, Number(d.value)]);

  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, tenantId));
  const integrationRows = await db
    .select()
    .from(integrations)
    .where(eq(integrations.tenantId, tenantId));

  const scores = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.tenantId, tenantId))
    .orderBy(desc(healthScores.computedAt))
    .limit(100);
  const latestScores = new Map<string, (typeof scores)[number]>();
  for (const s of scores) if (!latestScores.has(s.clientId)) latestScores.set(s.clientId, s);

  const recentRecs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.tenantId, tenantId))
    .orderBy(desc(recommendations.createdAt))
    .limit(5);

  const openTickets = await db
    .select({ count: dsql<string>`COUNT(*)` })
    .from(tickets)
    .where(and(eq(tickets.tenantId, tenantId), dsql`${tickets.status} IN ('open','in_progress')`));

  const runningJobs = await db
    .select({ count: dsql<string>`COUNT(*)` })
    .from(aiJobs)
    .where(and(eq(aiJobs.tenantId, tenantId), dsql`${aiJobs.status} IN ('queued','running')`));

  const integrationStatus = [
    { name: "Connected", value: integrationRows.filter((i) => i.status === "connected").length },
    { name: "Syncing", value: integrationRows.filter((i) => i.status === "syncing").length },
    { name: "Error", value: integrationRows.filter((i) => ["error", "token_expired"].includes(i.status)).length },
    { name: "Disconnected", value: integrationRows.filter((i) => i.status === "disconnected").length },
  ].filter((s) => s.value > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Operations Dashboard</h1>
        <div className="text-sm text-muted-foreground">
          {clientRows.length} clients · {integrationRows.length} integrations ·{" "}
          {Number(runningJobs[0]?.count ?? 0)} AI jobs in flight
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Ad Spend (30d)"
          value={formatCurrency(kpiMap.get("spend")?.current ?? 0)}
          delta={delta(kpiMap.get("spend"))}
          invertDelta
          sourceHint={trace(kpiMap.get("spend"))}
        />
        <KpiCard
          label="Revenue (30d)"
          value={formatCurrency(kpiMap.get("revenue")?.current ?? 0)}
          delta={delta(kpiMap.get("revenue"))}
          sourceHint={trace(kpiMap.get("revenue"))}
        />
        <KpiCard
          label="Conversions (30d)"
          value={formatNumber(kpiMap.get("conversions")?.current ?? 0)}
          delta={delta(kpiMap.get("conversions"))}
          sourceHint={trace(kpiMap.get("conversions"))}
        />
        <KpiCard
          label="Open Tickets"
          value={String(openTickets[0]?.count ?? 0)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Spend vs Revenue — trailing 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            {daily.length > 0 ? (
              <TimeSeriesChart
                series={[
                  { name: "Spend", data: seriesFor("spend") },
                  { name: "Revenue", data: seriesFor("revenue"), area: true },
                ]}
              />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No metric data yet — connect an integration to start ingesting live data.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Integration status</CardTitle>
          </CardHeader>
          <CardContent>
            {integrationStatus.length > 0 ? (
              <DonutChart data={integrationStatus} />
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">No integrations yet.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Client health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {clientRows.slice(0, 8).map((client) => {
              const score = latestScores.get(client.id);
              return (
                <Link
                  key={client.id}
                  href={`/clients/${client.id}`}
                  className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted/50"
                >
                  <div>
                    <div className="text-sm font-medium">{client.name}</div>
                    <div className="text-xs text-muted-foreground">{client.industry ?? "—"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {score && (
                      <span
                        className={`text-sm font-semibold ${Number(score.score) >= 70 ? "text-emerald-600" : Number(score.score) >= 50 ? "text-amber-600" : "text-red-600"}`}
                      >
                        {Number(score.score).toFixed(0)}
                      </span>
                    )}
                    <Badge variant={statusVariant(client.status)}>{client.status}</Badge>
                  </div>
                </Link>
              );
            })}
            {clientRows.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No clients yet — <Link className="text-primary underline" href="/clients">add your first client</Link>.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Latest recommendations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {recentRecs.map((rec) => (
              <div key={rec.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">{rec.title}</div>
                  <Badge variant={statusVariant(rec.status)}>{rec.status}</Badge>
                </div>
                {rec.confidenceScore && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {Number(rec.confidenceScore).toFixed(0)}% confidence · {rec.evidenceCount} evidence
                    items · {(rec.dataSources as string[]).join(", ") || "no sources"}
                  </div>
                )}
              </div>
            ))}
            {recentRecs.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">No recommendations yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
