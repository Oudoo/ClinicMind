import { notFound, redirect } from "next/navigation";
import { and, desc, eq, gte, sql as dsql } from "drizzle-orm";
import {
  db,
  clients,
  metricRecords,
  catApprovals,
  creativeAssets,
  sprintShowcases,
  knowledgeDocuments,
  recommendations,
  tickets,
  healthScores,
} from "@growengine/db";
import { presignedUrl } from "@growengine/core";
import { requireUser } from "@/lib/session";
import { decideCatApproval } from "@/app/actions/creative";
import { decideRecommendation } from "@/app/actions/intelligence";
import { createTicket } from "@/app/actions/work";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ConfidenceBadge, Progress } from "@/components/ui/progress";
import { KpiCard } from "@/components/kpi-card";
import { TimeSeriesChart } from "@/components/charts/presets";
import { Markdown } from "@/components/markdown";
import { SignOutButton } from "@/components/signout";
import { formatCurrency, formatNumber , formAction } from "@/lib/utils";
import Link from "next/link";

/**
 * Client Portal — external transparency: live KPIs with trace links,
 * gamified milestones, CAT approvals, showcases, reports and tickets.
 */
export default async function ClientPortalPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser();

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.slug, slug), eq(clients.tenantId, user.tenantId)));
  if (!client) notFound();
  // Portal users may only see their own client
  if (user.clientId && user.clientId !== client.id) redirect(`/client/${user.tenantSlug}`);

  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const since90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const [kpis, daily, approvals, assets, showcases, docs, recs, ticketRows, score] =
    await Promise.all([
      db
        .select({
          metric: metricRecords.metric,
          current: dsql<string>`SUM(CASE WHEN ${metricRecords.date} >= ${since30} THEN ${metricRecords.value} ELSE 0 END)`,
          requestIds: dsql<string>`COUNT(DISTINCT ${metricRecords.sourceRequestId})`,
        })
        .from(metricRecords)
        .where(and(eq(metricRecords.tenantId, user.tenantId), eq(metricRecords.clientId, client.id), gte(metricRecords.date, since30)))
        .groupBy(metricRecords.metric),
      db
        .select({
          date: metricRecords.date,
          metric: metricRecords.metric,
          value: dsql<string>`SUM(${metricRecords.value})`,
        })
        .from(metricRecords)
        .where(and(eq(metricRecords.tenantId, user.tenantId), eq(metricRecords.clientId, client.id), gte(metricRecords.date, since90)))
        .groupBy(metricRecords.date, metricRecords.metric)
        .orderBy(metricRecords.date),
      db.select().from(catApprovals).where(and(eq(catApprovals.tenantId, user.tenantId), eq(catApprovals.clientId, client.id))).orderBy(desc(catApprovals.requestedAt)),
      db.select().from(creativeAssets).where(and(eq(creativeAssets.tenantId, user.tenantId), eq(creativeAssets.clientId, client.id))),
      db.select().from(sprintShowcases).where(and(eq(sprintShowcases.tenantId, user.tenantId), eq(sprintShowcases.clientId, client.id), dsql`${sprintShowcases.publishedAt} IS NOT NULL`)).orderBy(desc(sprintShowcases.publishedAt)).limit(6),
      db.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.tenantId, user.tenantId), eq(knowledgeDocuments.clientId, client.id), dsql`${knowledgeDocuments.type} IN ('report','digest','qbr')`)).orderBy(desc(knowledgeDocuments.createdAt)).limit(12),
      db.select().from(recommendations).where(and(eq(recommendations.tenantId, user.tenantId), eq(recommendations.clientId, client.id), dsql`${recommendations.status} IN ('verified','presented','approved','implemented','measured')`)).orderBy(desc(recommendations.createdAt)).limit(10),
      db.select().from(tickets).where(and(eq(tickets.tenantId, user.tenantId), eq(tickets.clientId, client.id))).orderBy(desc(tickets.createdAt)).limit(10),
      db.select().from(healthScores).where(and(eq(healthScores.tenantId, user.tenantId), eq(healthScores.clientId, client.id))).orderBy(desc(healthScores.computedAt)).limit(1),
    ]);

  const kpiMap = new Map(kpis.map((k) => [k.metric, k]));
  const seriesFor = (metric: string): [string, number][] =>
    daily.filter((d) => d.metric === metric).map((d) => [d.date, Number(d.value)]);
  const milestones = (client.milestoneTargets ?? []) as {
    label: string;
    metric: string;
    target: number;
    achievedAt?: string;
  }[];
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const assetById = new Map(assets.map((a) => [a.id, a]));

  const showcaseUrls = new Map<string, string>();
  for (const s of showcases) {
    if (s.videoStorageKey) {
      try {
        showcaseUrls.set(s.id, await presignedUrl(s.videoStorageKey, 3600));
      } catch {
        /* storage unavailable */
      }
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold">{client.name} — Growth Portal</h1>
            <p className="text-xs text-muted-foreground">
              Powered by The Grow Engine · every number traces to its data source
            </p>
          </div>
          <div className="flex items-center gap-3">
            {score[0] && (
              <div className="text-right">
                <div className="text-xs text-muted-foreground">Account health</div>
                <div className={`text-lg font-bold ${Number(score[0].score) >= 70 ? "text-emerald-600" : "text-amber-600"}`}>
                  {Number(score[0].score).toFixed(0)}/100
                </div>
              </div>
            )}
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {pendingApprovals.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            ⚡ {pendingApprovals.length} creative{pendingApprovals.length > 1 ? "s" : ""} awaiting your
            sign-off below — pilots can&apos;t launch without your approval.
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard
            label="Investment (30d)"
            value={formatCurrency(kpiMap.get("spend")?.current ?? 0)}
            sourceHint={kpiMap.get("spend") ? `${kpiMap.get("spend")!.requestIds} verified API requests` : undefined}
          />
          <KpiCard
            label="Revenue (30d)"
            value={formatCurrency(kpiMap.get("revenue")?.current ?? 0)}
            sourceHint={kpiMap.get("revenue") ? `${kpiMap.get("revenue")!.requestIds} verified API requests` : undefined}
          />
          <KpiCard label="Conversions (30d)" value={formatNumber(kpiMap.get("conversions")?.current ?? 0)} />
          <KpiCard label="Leads (30d)" value={formatNumber(kpiMap.get("leads")?.current ?? 0)} />
        </div>

        <Tabs defaultValue="performance">
          <TabsList>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="milestones">Milestones</TabsTrigger>
            <TabsTrigger value="approvals">
              Approvals{pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="showcases">Showcases</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
            <TabsTrigger value="support">Support</TabsTrigger>
          </TabsList>

          <TabsContent value="performance">
            <Card>
              <CardHeader><CardTitle>90-day performance</CardTitle></CardHeader>
              <CardContent>
                {daily.length > 0 ? (
                  <TimeSeriesChart
                    series={[
                      { name: "Spend", data: seriesFor("spend") },
                      { name: "Revenue", data: seriesFor("revenue"), area: true },
                      { name: "Conversions", data: seriesFor("conversions") },
                    ].filter((s) => s.data.length > 0)}
                    height={380}
                  />
                ) : (
                  <p className="py-12 text-center text-sm text-muted-foreground">
                    Data will appear here as soon as your channels are connected.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="milestones">
            <Card>
              <CardHeader>
                <CardTitle>🏆 Growth milestones</CardTitle>
                <CardDescription>Targets we celebrate together — tracked from live data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {milestones.map((m, i) => {
                  const current = Number(kpiMap.get(m.metric)?.current ?? 0);
                  const pct = m.achievedAt ? 100 : Math.min(100, (current / m.target) * 100);
                  return (
                    <div key={i} className={m.achievedAt ? "rounded-md border border-emerald-300 bg-emerald-50 p-3" : "rounded-md border p-3"}>
                      <div className="mb-1.5 flex items-center justify-between">
                        <span className="font-medium">
                          {m.achievedAt ? "🎉 " : ""}{m.label}
                          {m.achievedAt && <span className="ml-2 text-xs text-emerald-700">achieved {m.achievedAt.slice(0, 10)}</span>}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {formatNumber(current)} / {formatNumber(m.target)} {m.metric}
                        </span>
                      </div>
                      <Progress value={pct} />
                    </div>
                  );
                })}
                {milestones.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Your team will define milestone targets shortly.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="approvals" className="space-y-3">
            {approvals.map((approval) => {
              const asset = assetById.get(approval.creativeAssetId);
              return (
                <Card key={approval.id}>
                  <CardContent className="pt-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-medium">{asset?.name ?? "Creative asset"}</div>
                        <div className="text-xs text-muted-foreground">
                          {asset?.assetType} · {(asset?.platforms as string[] | undefined)?.join(", ")}
                          · requested {approval.requestedAt.toISOString().slice(0, 10)}
                        </div>
                      </div>
                      <Badge variant={statusVariant(approval.status)}>{approval.status.replace(/_/g, " ")}</Badge>
                    </div>
                    {asset?.copyText && (
                      <div className="mt-2 rounded-md bg-muted/60 p-3 text-sm">{asset.copyText}</div>
                    )}
                    {approval.status === "pending" && (
                      <form action={formAction(decideCatApproval.bind(null, approval.id))} className="mt-3 space-y-2">
                        <div className="space-y-1 text-sm">
                          <div className="text-xs font-semibold uppercase text-muted-foreground">Sign-off checklist</div>
                          {(approval.checklist as { key: string; label: string }[]).map((item) => (
                            <label key={item.key} className="flex items-center gap-2">
                              <input type="checkbox" required /> {item.label}
                            </label>
                          ))}
                        </div>
                        <Textarea name="note" placeholder="Notes (optional)" rows={2} />
                        <div className="flex gap-2">
                          <Button type="submit" name="decision" value="approved">Approve — launch 7-day pilot</Button>
                          <Button type="submit" name="decision" value="changes_requested" variant="outline">Request changes</Button>
                          <Button type="submit" name="decision" value="rejected" variant="ghost" className="text-destructive">Reject</Button>
                        </div>
                      </form>
                    )}
                    {approval.decisionNote && (
                      <p className="mt-2 text-sm text-muted-foreground">Your note: {approval.decisionNote}</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
            {approvals.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">No approval requests yet.</p>
            )}
          </TabsContent>

          <TabsContent value="showcases" className="grid gap-4 md:grid-cols-2">
            {showcases.map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle className="text-base">{s.title}</CardTitle>
                  <CardDescription>Sprint {s.sprintStart} → {s.sprintEnd}</CardDescription>
                </CardHeader>
                <CardContent>
                  {showcaseUrls.has(s.id) && (
                    <video controls className="w-full rounded-md" src={showcaseUrls.get(s.id)} />
                  )}
                  {s.summary && <p className="mt-2 text-sm text-muted-foreground">{s.summary}</p>}
                </CardContent>
              </Card>
            ))}
            {showcases.length === 0 && (
              <p className="col-span-2 py-10 text-center text-sm text-muted-foreground">
                Bi-weekly sprint video showcases will appear here.
              </p>
            )}
          </TabsContent>

          <TabsContent value="reports" className="space-y-2">
            {docs.map((doc) => (
              <details key={doc.id} className="rounded-md border bg-card px-4 py-3">
                <summary className="cursor-pointer">
                  <span className="text-sm font-medium">{doc.title}</span>
                  <Badge variant="outline" className="ml-2">{doc.type}</Badge>
                </summary>
                <div className="mt-3"><Markdown content={doc.contentMarkdown} /></div>
              </details>
            ))}
            {docs.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Weekly digests, reports and QBRs will be published here automatically.
              </p>
            )}
          </TabsContent>

          <TabsContent value="recommendations" className="space-y-3">
            {recs.map((rec) => (
              <Card key={rec.id}>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between">
                    <div className="font-medium">{rec.title}</div>
                    <Badge variant={statusVariant(rec.status)}>{rec.status}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{rec.body}</p>
                  <div className="mt-2">
                    <ConfidenceBadge
                      score={rec.confidenceScore}
                      evidenceCount={rec.evidenceCount}
                      sources={rec.dataSources as string[]}
                    />
                  </div>
                  {["verified", "presented"].includes(rec.status) && (
                    <form action={formAction(decideRecommendation.bind(null, rec.id))} className="mt-3 flex items-end gap-2">
                      <div className="flex-1">
                        <Label>Your decision</Label>
                        <Input name="reason" placeholder="Reason (optional)" />
                      </div>
                      <Select name="outcome" className="w-32">
                        <option value="approved">Approve</option>
                        <option value="rejected">Reject</option>
                        <option value="deferred">Defer</option>
                      </Select>
                      <Button type="submit" size="sm">Submit</Button>
                    </form>
                  )}
                </CardContent>
              </Card>
            ))}
            {recs.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Verified recommendations will appear here with their supporting evidence.
              </p>
            )}
          </TabsContent>

          <TabsContent value="support" className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-2">
              {ticketRows.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-md border bg-card px-4 py-2.5">
                  <div>
                    <span className="text-xs text-muted-foreground">#{t.number}</span>{" "}
                    <span className="text-sm font-medium">{t.subject}</span>
                  </div>
                  <Badge variant={statusVariant(t.status)}>{t.status.replace(/_/g, " ")}</Badge>
                </div>
              ))}
              {ticketRows.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">No support tickets.</p>
              )}
            </div>
            <Card className="h-fit">
              <CardHeader><CardTitle>New request</CardTitle></CardHeader>
              <CardContent>
                <form action={formAction(createTicket)} className="space-y-3">
                  <div>
                    <Label>Subject</Label>
                    <Input name="subject" required />
                  </div>
                  <div>
                    <Label>Priority</Label>
                    <Select name="priority">
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </Select>
                  </div>
                  <div>
                    <Label>Details</Label>
                    <Textarea name="description" rows={4} />
                  </div>
                  <Button type="submit" className="w-full">Submit</Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {!user.clientId && (
          <p className="text-center text-xs text-muted-foreground">
            You are viewing this portal as an internal team member.{" "}
            <Link href={`/clients/${client.id}`} className="text-primary underline">Back to workspace</Link>
          </p>
        )}
      </main>
    </div>
  );
}
