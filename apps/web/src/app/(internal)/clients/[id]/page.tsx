import { notFound } from "next/navigation";
import Link from "next/link";
import { and, desc, eq, gte, sql as dsql } from "drizzle-orm";
import {
  db,
  clients,
  metricRecords,
  forecasts,
  seasonalityPatterns,
  lostOpportunities,
  healthScores,
  recommendations,
  decisions,
  dmaicProjects,
  tasks,
  creativeAssets,
  catApprovals,
  abPilots,
  aeoAudits,
  knowledgeDocuments,
  meetings,
  sprintShowcases,
  processInsights,
} from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ConfidenceBadge, Progress } from "@/components/ui/progress";
import { KpiCard } from "@/components/kpi-card";
import {
  TimeSeriesChart,
  ForecastChart,
  SeasonalityHeatmap,
  GaugeChart,
} from "@/components/charts/presets";
import { formatCurrency, formatNumber , formAction } from "@/lib/utils";
import {
  createRecommendation,
  decideRecommendation,
  createDmaicProject,
  advanceDmaicPhase,
  requestForecast,
  requestSeasonalityAndLostOpportunity,
  requestAeoAudit,
  requestCompetitorAnalysis,
  requestQbr,
  requestReport,
} from "@/app/actions/intelligence";
import {
  createCreativeAsset,
  requestCatApproval,
  createPilot,
  concludePilot,
} from "@/app/actions/creative";
import { addMilestoneTarget } from "@/app/actions/clients";
import { publishShowcase } from "@/app/actions/work";

export default async function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireTeamUser();
  const tenantId = user.tenantId;

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, id), eq(clients.tenantId, tenantId)));
  if (!client) notFound();

  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const since90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const [
    kpis,
    daily,
    forecastRows,
    seasonality,
    lostOpps,
    score,
    recs,
    decisionRows,
    dmaicRows,
    dmaicTasks,
    assets,
    approvals,
    pilots,
    aeoRows,
    docs,
    meetingRows,
    showcases,
    insights,
  ] = await Promise.all([
    db
      .select({
        metric: metricRecords.metric,
        current: dsql<string>`SUM(CASE WHEN ${metricRecords.date} >= ${since30} THEN ${metricRecords.value} ELSE 0 END)`,
        requestIds: dsql<string>`COUNT(DISTINCT ${metricRecords.sourceRequestId})`,
      })
      .from(metricRecords)
      .where(and(eq(metricRecords.tenantId, tenantId), eq(metricRecords.clientId, id), gte(metricRecords.date, since30)))
      .groupBy(metricRecords.metric),
    db
      .select({
        date: metricRecords.date,
        metric: metricRecords.metric,
        value: dsql<string>`SUM(${metricRecords.value})`,
      })
      .from(metricRecords)
      .where(and(eq(metricRecords.tenantId, tenantId), eq(metricRecords.clientId, id), gte(metricRecords.date, since90)))
      .groupBy(metricRecords.date, metricRecords.metric)
      .orderBy(metricRecords.date),
    db.select().from(forecasts).where(and(eq(forecasts.tenantId, tenantId), eq(forecasts.clientId, id))).orderBy(desc(forecasts.createdAt)).limit(6),
    db.select().from(seasonalityPatterns).where(and(eq(seasonalityPatterns.tenantId, tenantId), eq(seasonalityPatterns.clientId, id))).orderBy(desc(seasonalityPatterns.computedAt)).limit(1),
    db.select().from(lostOpportunities).where(and(eq(lostOpportunities.tenantId, tenantId), eq(lostOpportunities.clientId, id))).orderBy(desc(lostOpportunities.createdAt)).limit(3),
    db.select().from(healthScores).where(and(eq(healthScores.tenantId, tenantId), eq(healthScores.clientId, id))).orderBy(desc(healthScores.computedAt)).limit(1),
    db.select().from(recommendations).where(and(eq(recommendations.tenantId, tenantId), eq(recommendations.clientId, id))).orderBy(desc(recommendations.createdAt)).limit(20),
    db.select().from(decisions).where(and(eq(decisions.tenantId, tenantId), eq(decisions.clientId, id))).orderBy(desc(decisions.decidedAt)).limit(20),
    db.select().from(dmaicProjects).where(and(eq(dmaicProjects.tenantId, tenantId), eq(dmaicProjects.clientId, id))).orderBy(desc(dmaicProjects.createdAt)),
    db.select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.clientId, id), dsql`${tasks.dmaicProjectId} IS NOT NULL`)),
    db.select().from(creativeAssets).where(and(eq(creativeAssets.tenantId, tenantId), eq(creativeAssets.clientId, id))).orderBy(desc(creativeAssets.createdAt)),
    db.select().from(catApprovals).where(and(eq(catApprovals.tenantId, tenantId), eq(catApprovals.clientId, id))).orderBy(desc(catApprovals.requestedAt)),
    db.select().from(abPilots).where(and(eq(abPilots.tenantId, tenantId), eq(abPilots.clientId, id))).orderBy(desc(abPilots.createdAt)),
    db.select().from(aeoAudits).where(and(eq(aeoAudits.tenantId, tenantId), eq(aeoAudits.clientId, id))).orderBy(desc(aeoAudits.createdAt)).limit(5),
    db.select().from(knowledgeDocuments).where(and(eq(knowledgeDocuments.tenantId, tenantId), eq(knowledgeDocuments.clientId, id))).orderBy(desc(knowledgeDocuments.createdAt)).limit(30),
    db.select().from(meetings).where(and(eq(meetings.tenantId, tenantId), eq(meetings.clientId, id))).orderBy(desc(meetings.createdAt)).limit(10),
    db.select().from(sprintShowcases).where(and(eq(sprintShowcases.tenantId, tenantId), eq(sprintShowcases.clientId, id))).orderBy(desc(sprintShowcases.createdAt)).limit(5),
    db.select().from(processInsights).where(and(eq(processInsights.tenantId, tenantId), eq(processInsights.clientId, id))).orderBy(desc(processInsights.computedAt)).limit(5),
  ]);

  const kpiMap = new Map(kpis.map((k) => [k.metric, k]));
  const seriesFor = (metric: string): [string, number][] =>
    daily.filter((d) => d.metric === metric).map((d) => [d.date, Number(d.value)]);
  const latestForecast = forecastRows.find((f) => f.status === "completed");
  const decisionByRec = new Map(
    decisionRows.filter((d) => d.sourceEntityType === "recommendation").map((d) => [d.sourceEntityId, d])
  );
  const milestones = (client.milestoneTargets ?? []) as {
    label: string;
    metric: string;
    target: number;
    achievedAt?: string;
  }[];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{client.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant={statusVariant(client.status)}>{client.status}</Badge>
            {client.industry && <span>{client.industry}</span>}
            {client.websiteUrl && (
              <a href={client.websiteUrl} target="_blank" className="text-primary underline">
                {client.websiteUrl}
              </a>
            )}
            <Link href={`/client/${client.slug}`} className="text-primary underline">
              Client portal →
            </Link>
          </div>
        </div>
        <div className="flex gap-2">
          <form action={formAction(requestQbr.bind(null, client.id))}>
            <Button variant="outline" size="sm">Generate QBR</Button>
          </form>
          <form action={formAction(requestReport.bind(null, client.id, `Performance Report — ${new Date().toISOString().slice(0, 10)}`, undefined))}>
            <Button variant="outline" size="sm">Generate report</Button>
          </form>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="recommendations">Recommendations</TabsTrigger>
          <TabsTrigger value="dmaic">DMAIC</TabsTrigger>
          <TabsTrigger value="creative">Creative & CAT</TabsTrigger>
          <TabsTrigger value="aeo">AEO & Research</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>

        {/* ───────────── OVERVIEW ───────────── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard
              label="Spend (30d)"
              value={formatCurrency(kpiMap.get("spend")?.current ?? 0)}
              sourceHint={kpiMap.get("spend") ? `${kpiMap.get("spend")!.requestIds} API request ids traced` : undefined}
            />
            <KpiCard
              label="Revenue (30d)"
              value={formatCurrency(kpiMap.get("revenue")?.current ?? 0)}
              sourceHint={kpiMap.get("revenue") ? `${kpiMap.get("revenue")!.requestIds} API request ids traced` : undefined}
            />
            <KpiCard label="Conversions (30d)" value={formatNumber(kpiMap.get("conversions")?.current ?? 0)} />
            <KpiCard label="Leads (30d)" value={formatNumber(kpiMap.get("leads")?.current ?? 0)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle>Performance — 90 days</CardTitle></CardHeader>
              <CardContent>
                {daily.length > 0 ? (
                  <TimeSeriesChart
                    series={[
                      { name: "Spend", data: seriesFor("spend") },
                      { name: "Revenue", data: seriesFor("revenue"), area: true },
                      { name: "Conversions", data: seriesFor("conversions") },
                    ].filter((s) => s.data.length > 0)}
                  />
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">No metric data yet for this client.</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Health score</CardTitle>
                {score[0] && <CardDescription>trend: {score[0].trend}</CardDescription>}
              </CardHeader>
              <CardContent>
                {score[0] ? (
                  <>
                    <GaugeChart value={Number(score[0].score)} />
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {(score[0].drivers as { name: string; detail: string }[]).slice(0, 3).map((d, i) => (
                        <li key={i}>• {d.name}: {d.detail}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">Computed daily once data flows.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Forecasts</CardTitle>
                <div className="flex gap-1.5">
                  {["revenue", "conversions", "spend"].map((m) => (
                    <form key={m} action={formAction(requestForecast.bind(null, client.id, m, 30))}>
                      <Button variant="outline" size="sm">+ {m}</Button>
                    </form>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                {latestForecast ? (
                  <>
                    <div className="mb-2 flex items-center gap-2 text-sm">
                      <span className="font-medium capitalize">{latestForecast.metric}</span>
                      <ConfidenceBadge
                        score={latestForecast.confidenceScore}
                        evidenceCount={latestForecast.evidenceCount}
                        sources={latestForecast.dataSources as string[]}
                      />
                      {latestForecast.backtestMape && (
                        <span className="text-xs text-muted-foreground">backtest MAPE {Number(latestForecast.backtestMape).toFixed(1)}%</span>
                      )}
                    </div>
                    <ForecastChart
                      history={seriesFor(latestForecast.metric).slice(-45)}
                      forecast={latestForecast.points as { date: string; value: number; lower: number; upper: number }[]}
                    />
                    {latestForecast.narrative && (
                      <p className="mt-2 text-sm text-muted-foreground">{latestForecast.narrative}</p>
                    )}
                  </>
                ) : (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No completed forecasts yet — request one above. Runs in the AI worker.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Seasonality & lost opportunity</CardTitle>
                <form action={formAction(requestSeasonalityAndLostOpportunity.bind(null, client.id, "revenue"))}>
                  <Button variant="outline" size="sm">Analyze revenue</Button>
                </form>
              </CardHeader>
              <CardContent>
                {seasonality[0] ? (
                  <>
                    <SeasonalityHeatmap cells={seasonality[0].heatmap as { month: number; index: number; label: string }[]} />
                    <div className="mt-1 text-xs text-muted-foreground">
                      metric: {seasonality[0].metric} · confidence {Number(seasonality[0].confidenceScore ?? 0).toFixed(0)}%
                    </div>
                  </>
                ) : (
                  <p className="py-4 text-center text-sm text-muted-foreground">Needs 60+ days of data.</p>
                )}
                {lostOpps.map((opp) => (
                  <div key={opp.id} className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
                    <div className="font-medium">{opp.title}</div>
                    <div className="text-amber-800">
                      Missed {formatCurrency(opp.missedValueLow)} – {formatCurrency(opp.missedValueHigh)}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <ConfidenceBadge score={opp.confidenceScore} evidenceCount={opp.evidenceCount} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{opp.methodology}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Gamified milestones</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {milestones.map((m, i) => {
                  const current = Number(kpiMap.get(m.metric)?.current ?? 0);
                  const pct = Math.min(100, (current / m.target) * 100);
                  return (
                    <div key={i}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium">
                          {m.achievedAt ? "🏆 " : ""}{m.label}
                        </span>
                        <span className="text-muted-foreground">
                          {formatNumber(current)} / {formatNumber(m.target)} {m.metric}
                        </span>
                      </div>
                      <Progress value={m.achievedAt ? 100 : pct} />
                    </div>
                  );
                })}
                <form action={formAction(addMilestoneTarget.bind(null, client.id))} className="grid grid-cols-4 gap-2 border-t pt-3">
                  <Input name="label" placeholder="Label" required className="col-span-2" />
                  <Select name="metric" required>
                    <option value="revenue">revenue</option>
                    <option value="leads">leads</option>
                    <option value="conversions">conversions</option>
                  </Select>
                  <Input name="target" type="number" placeholder="Target" required />
                  <Button type="submit" size="sm" className="col-span-4">Add milestone</Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Sprint showcases</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {showcases.map((s) => (
                  <div key={s.id} className="rounded-md border px-3 py-2 text-sm">
                    <div className="font-medium">{s.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.sprintStart} → {s.sprintEnd} {s.videoStorageKey ? "· 🎬 video attached" : ""}
                    </div>
                  </div>
                ))}
                <form action={formAction(publishShowcase)} className="space-y-2 border-t pt-3">
                  <input type="hidden" name="clientId" value={client.id} />
                  <Input name="title" placeholder="Showcase title" required />
                  <div className="grid grid-cols-2 gap-2">
                    <Input name="sprintStart" type="date" />
                    <Input name="sprintEnd" type="date" />
                  </div>
                  <Textarea name="summary" placeholder="What shipped this sprint…" rows={2} />
                  <input type="file" name="video" accept="video/*" className="text-xs" />
                  <Button type="submit" size="sm">Publish to portal</Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {insights.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Process intelligence findings</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {insights.map((ins) => (
                  <div key={ins.id} className="rounded-md border px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{ins.title}</span>
                      <Badge variant={ins.severity === "high" ? "destructive" : ins.severity === "medium" ? "warning" : "secondary"}>
                        {ins.insightType} · {ins.severity}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{ins.finding}</p>
                    <p className="mt-1 text-sm"><strong>Action:</strong> {ins.recommendedAction}</p>
                    <ConfidenceBadge score={ins.confidenceScore} evidenceCount={ins.evidenceCount} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ───────────── RECOMMENDATIONS ───────────── */}
        <TabsContent value="recommendations" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              {recs.map((rec) => {
                const decision = decisionByRec.get(rec.id);
                return (
                  <Card key={rec.id}>
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between">
                        <div className="font-medium">{rec.title}</div>
                        <Badge variant={statusVariant(rec.status)}>{rec.status}</Badge>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{rec.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <ConfidenceBadge
                          score={rec.confidenceScore}
                          evidenceCount={rec.evidenceCount}
                          sources={rec.dataSources as string[]}
                        />
                        <Badge variant="outline">{rec.category}</Badge>
                      </div>
                      {(rec.evidence as { claim: string; verdict: string; evidence: string; sourceRequestIds?: string[] }[]).length > 0 && (
                        <div className="mt-3 space-y-1.5 rounded-md bg-muted/60 p-3">
                          <div className="text-xs font-semibold uppercase text-muted-foreground">Verification evidence</div>
                          {(rec.evidence as { claim: string; verdict: string; evidence: string; sourceRequestIds?: string[] }[]).map((e, i) => (
                            <div key={i} className="text-xs">
                              <span className={e.verdict === "supported" ? "text-emerald-700" : e.verdict === "unsupported" ? "text-red-700" : "text-amber-700"}>
                                [{e.verdict}]
                              </span>{" "}
                              {e.claim} — <span className="text-muted-foreground">{e.evidence}</span>
                              {e.sourceRequestIds?.length ? (
                                <span className="text-muted-foreground"> · req: {e.sourceRequestIds.slice(0, 2).join(", ")}</span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                      {decision ? (
                        <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 p-2 text-sm">
                          <strong>Decision:</strong> {decision.outcome}
                          {decision.reason && <> — {decision.reason}</>}
                          <span className="text-muted-foreground"> · by {decision.approvedByName ?? "—"}</span>
                        </div>
                      ) : (
                        ["verified", "presented", "proposed"].includes(rec.status) && (
                          <form action={formAction(decideRecommendation.bind(null, rec.id))} className="mt-3 flex items-end gap-2">
                            <div className="flex-1">
                              <Label>Record decision</Label>
                              <Input name="reason" placeholder="Reason (e.g. budget constraints)" />
                            </div>
                            <Select name="outcome" className="w-32" required>
                              <option value="approved">Approve</option>
                              <option value="rejected">Reject</option>
                              <option value="deferred">Defer</option>
                              <option value="modified">Modify</option>
                            </Select>
                            <Button type="submit" size="sm">Save</Button>
                          </form>
                        )
                      )}
                    </CardContent>
                  </Card>
                );
              })}
              {recs.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">No recommendations yet.</p>
              )}
            </div>

            <Card className="h-fit">
              <CardHeader>
                <CardTitle>New recommendation</CardTitle>
                <CardDescription>
                  The Verification Engine will check every claim against live metric data before
                  it can be presented.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={formAction(createRecommendation)} className="space-y-3">
                  <input type="hidden" name="clientId" value={client.id} />
                  <div>
                    <Label htmlFor="rec-title">Title</Label>
                    <Input id="rec-title" name="title" required />
                  </div>
                  <div>
                    <Label htmlFor="rec-category">Category</Label>
                    <Select id="rec-category" name="category">
                      <option value="marketing">Marketing</option>
                      <option value="operations">Operations</option>
                      <option value="creative">Creative</option>
                      <option value="budget">Budget</option>
                      <option value="technical">Technical</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="rec-body">Recommendation (include factual claims)</Label>
                    <Textarea id="rec-body" name="body" rows={6} required />
                  </div>
                  <Button type="submit" className="w-full">Create & verify</Button>
                </form>
              </CardContent>
            </Card>
          </div>

          {decisionRows.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Decision log</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {decisionRows.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                    <span>{d.title}</span>
                    <span className="text-xs text-muted-foreground">
                      <Badge variant={statusVariant(d.outcome)}>{d.outcome}</Badge>{" "}
                      {d.approvedByName ?? ""} · {d.decidedAt.toISOString().slice(0, 10)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ───────────── DMAIC ───────────── */}
        <TabsContent value="dmaic" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              {dmaicRows.map((project) => {
                const phases = project.phases as Record<string, unknown>;
                const projectTasks = dmaicTasks.filter((t) => t.dmaicProjectId === project.id);
                const phaseOrder = ["define", "measure", "analyze", "improve", "control"];
                return (
                  <Card key={project.id}>
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between">
                        <div className="font-medium">{project.title}</div>
                        <div className="flex items-center gap-2">
                          <Badge variant="info">phase: {project.currentPhase}</Badge>
                          {project.currentPhase !== "completed" && (
                            <form action={formAction(advanceDmaicPhase.bind(null, project.id))}>
                              <Button variant="outline" size="sm">Advance phase →</Button>
                            </form>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{project.problemStatement}</p>
                      <div className="mt-2">
                        <ConfidenceBadge
                          score={project.confidenceScore}
                          evidenceCount={project.evidenceCount}
                          sources={project.dataSources as string[]}
                        />
                      </div>
                      <div className="mt-3 grid grid-cols-5 gap-1.5">
                        {phaseOrder.map((phase) => (
                          <div
                            key={phase}
                            className={`rounded-md border p-2 text-center text-xs capitalize ${
                              phase === project.currentPhase
                                ? "border-primary bg-accent font-semibold"
                                : phases[phase]
                                  ? "bg-muted/50"
                                  : "opacity-50"
                            }`}
                          >
                            {phase}
                          </div>
                        ))}
                      </div>
                      {projectTasks.length > 0 && (
                        <div className="mt-3 space-y-1">
                          <div className="text-xs font-semibold uppercase text-muted-foreground">
                            Generated tasks ({projectTasks.filter((t) => t.status === "done").length}/{projectTasks.length} done)
                          </div>
                          {projectTasks.slice(0, 8).map((t) => (
                            <div key={t.id} className="flex items-center justify-between text-sm">
                              <span className={t.status === "done" ? "line-through text-muted-foreground" : ""}>
                                {t.title}
                              </span>
                              <span className="text-xs text-muted-foreground">{t.dmaicPhase} · {t.dueDate ?? "no due"}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
              {dmaicRows.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No DMAIC projects yet — describe a problem and the engine builds the full
                  Define→Control plan with tasks and timeline.
                </p>
              )}
            </div>
            <Card className="h-fit">
              <CardHeader>
                <CardTitle>New DMAIC project</CardTitle>
                <CardDescription>Generated from real metric baselines by the AI worker.</CardDescription>
              </CardHeader>
              <CardContent>
                <form action={formAction(createDmaicProject)} className="space-y-3">
                  <input type="hidden" name="clientId" value={client.id} />
                  <div>
                    <Label htmlFor="dmaic-title">Title</Label>
                    <Input id="dmaic-title" name="title" required />
                  </div>
                  <div>
                    <Label htmlFor="dmaic-problem">Problem statement</Label>
                    <Textarea id="dmaic-problem" name="problemStatement" rows={5} required
                      placeholder="e.g. CPA increased 40% over 60 days while lead quality dropped…" />
                  </div>
                  <Button type="submit" className="w-full">Generate DMAIC plan</Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ───────────── CREATIVE & CAT ───────────── */}
        <TabsContent value="creative" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-3 lg:col-span-2">
              {assets.map((asset) => {
                const approval = approvals.find((a) => a.creativeAssetId === asset.id);
                const pilot = pilots.find((p) => p.creativeAssetId === asset.id);
                return (
                  <Card key={asset.id}>
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between">
                        <div>
                          <span className="font-medium">{asset.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {asset.assetType} · {(asset.platforms as string[]).join(", ")}
                          </span>
                        </div>
                        <Badge variant={statusVariant(asset.status)}>{asset.status.replace(/_/g, " ")}</Badge>
                      </div>
                      {asset.copyText && (
                        <p className="mt-1 text-sm text-muted-foreground line-clamp-3">{asset.copyText}</p>
                      )}
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {asset.status === "internal_review" && (
                          <form action={formAction(requestCatApproval.bind(null, asset.id))}>
                            <Button size="sm">Send for client sign-off (CAT)</Button>
                          </form>
                        )}
                        {approval && approval.status === "pending" && (
                          <span className="text-xs text-amber-700">Awaiting client approval in the portal…</span>
                        )}
                        {approval?.status === "approved" && asset.status === "approved" && (
                          <form action={formAction(createPilot.bind(null, asset.id))} className="flex items-end gap-2">
                            <Input name="name" placeholder="Pilot name" required className="w-36" />
                            <Select name="platform" className="w-28">
                              {(asset.platforms as string[]).map((p) => <option key={p}>{p}</option>)}
                            </Select>
                            <Input name="dailyBudget" type="number" step="0.01" placeholder="$/day" required className="w-24" />
                            <Input name="externalCampaignId" placeholder="Campaign id (optional)" className="w-40" />
                            <Button type="submit" size="sm">Launch 7-day pilot</Button>
                          </form>
                        )}
                        {pilot && pilot.status === "running" && (
                          <div className="flex items-center gap-2 text-sm">
                            <Badge variant="warning">pilot running {pilot.startDate} → {pilot.endDate}</Badge>
                            <form action={formAction(concludePilot.bind(null, pilot.id, true))}>
                              <Button size="sm" variant="outline">Promote & scale</Button>
                            </form>
                            <form action={formAction(concludePilot.bind(null, pilot.id, false))}>
                              <Button size="sm" variant="ghost">Stop</Button>
                            </form>
                          </div>
                        )}
                        {approval?.decisionNote && (
                          <span className="text-xs text-muted-foreground">Client note: {approval.decisionNote}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
              {assets.length === 0 && (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No creatives yet. The CAT flow: create → client sign-off → 7-day micro-budget pilot → scale.
                </p>
              )}
            </div>
            <Card className="h-fit">
              <CardHeader><CardTitle>New creative asset</CardTitle></CardHeader>
              <CardContent>
                <form action={formAction(createCreativeAsset)} className="space-y-3">
                  <input type="hidden" name="clientId" value={client.id} />
                  <div>
                    <Label>Name</Label>
                    <Input name="name" required />
                  </div>
                  <div>
                    <Label>Type</Label>
                    <Select name="assetType">
                      <option value="image">Image</option>
                      <option value="video">Video</option>
                      <option value="carousel">Carousel</option>
                      <option value="copy">Copy</option>
                      <option value="landing_page">Landing page</option>
                    </Select>
                  </div>
                  <div>
                    <Label>Platforms (comma separated)</Label>
                    <Input name="platforms" defaultValue="meta" />
                  </div>
                  <div>
                    <Label>Ad copy</Label>
                    <Textarea name="copyText" rows={3} />
                  </div>
                  <div>
                    <Label>File (optional)</Label>
                    <input type="file" name="file" className="text-xs" />
                  </div>
                  <Button type="submit" className="w-full">Create asset</Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ───────────── AEO & RESEARCH ───────────── */}
        <TabsContent value="aeo" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>AEO/GEO content audits</CardTitle>
                <form action={formAction(requestAeoAudit.bind(null, client.id, client.websiteUrl ?? ""))}>
                  <Button variant="outline" size="sm" disabled={!client.websiteUrl}>
                    Audit {client.websiteUrl ? new URL(client.websiteUrl).hostname : "site"}
                  </Button>
                </form>
              </CardHeader>
              <CardContent className="space-y-3">
                {aeoRows.map((a) => (
                  <div key={a.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{a.targetUrl}</span>
                      <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                    </div>
                    {a.status === "completed" && (
                      <>
                        <div className="mt-2 text-2xl font-bold">{Number(a.overallScore).toFixed(0)}/100</div>
                        <div className="mt-1 grid grid-cols-5 gap-1 text-center text-xs">
                          {Object.entries(a.dimensionScores as Record<string, number>).map(([k, v]) => (
                            <div key={k} className="rounded bg-muted p-1">
                              <div className="font-semibold">{v}</div>
                              <div className="text-[10px] text-muted-foreground">{k}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-2 space-y-1">
                          {(a.recommendations as { priority: string; recommendation: string }[]).slice(0, 4).map((r, i) => (
                            <div key={i} className="text-xs">
                              <Badge variant={r.priority === "high" ? "destructive" : r.priority === "medium" ? "warning" : "secondary"}>{r.priority}</Badge>{" "}
                              {r.recommendation}
                            </div>
                          ))}
                        </div>
                        <div className="mt-1"><ConfidenceBadge score={a.confidenceScore} /></div>
                      </>
                    )}
                    {a.error && <p className="mt-1 text-xs text-destructive">{a.error}</p>}
                  </div>
                ))}
                {aeoRows.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Audits evaluate structured data, schema markup and citeable quotes for generative AI search.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Competitor analysis</CardTitle></CardHeader>
              <CardContent>
                <CompetitorForm clientId={client.id} />
                <div className="mt-3 space-y-1.5">
                  {docs.filter((d) => d.type === "research").slice(0, 6).map((d) => (
                    <Link key={d.id} href={`/aom/doc/${d.id}`} className="block rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                      {d.title}
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>Meetings</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {meetingRows.map((m) => (
                <Link key={m.id} href={`/meetings/${m.id}`} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
                  <span>{m.title}</span>
                  <Badge variant={statusVariant(m.status)}>{m.status.replace(/_/g, " ")}</Badge>
                </Link>
              ))}
              {meetingRows.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No meetings — create one under <Link href="/meetings" className="text-primary underline">Meetings</Link>.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ───────────── DOCUMENTS ───────────── */}
        <TabsContent value="documents" className="space-y-3">
          {docs.map((doc) => (
            <Link key={doc.id} href={`/aom/doc/${doc.id}`} className="flex items-center justify-between rounded-md border bg-card px-4 py-3 hover:bg-muted/50">
              <div>
                <div className="text-sm font-medium">{doc.title}</div>
                <div className="text-xs text-muted-foreground">{doc.createdAt.toISOString().slice(0, 10)}</div>
              </div>
              <Badge variant="outline">{doc.type}</Badge>
            </Link>
          ))}
          {docs.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Reports, QBRs, digests, baselines and research will appear here as they are generated.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CompetitorForm({ clientId }: { clientId: string }) {
  async function action(formData: FormData) {
    "use server";
    await requestCompetitorAnalysis(
      clientId,
      String(formData.get("competitorName") ?? ""),
      String(formData.get("competitorUrl") ?? "")
    );
  }
  return (
    <form action={formAction(action)} className="flex items-end gap-2">
      <div className="flex-1">
        <Label>Competitor name</Label>
        <Input name="competitorName" required />
      </div>
      <div className="flex-1">
        <Label>Website</Label>
        <Input name="competitorUrl" type="url" placeholder="https://" required />
      </div>
      <Button type="submit" size="sm">Analyze</Button>
    </form>
  );
}
