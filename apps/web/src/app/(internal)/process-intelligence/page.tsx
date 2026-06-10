import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, processInsights, clients } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createAiJob } from "@/lib/jobs";
import { revalidatePath } from "next/cache";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfidenceBadge } from "@/components/ui/progress";

export default async function ProcessIntelligencePage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({ insight: processInsights, clientName: clients.name })
    .from(processInsights)
    .leftJoin(clients, eq(processInsights.clientId, clients.id))
    .where(eq(processInsights.tenantId, user.tenantId))
    .orderBy(desc(processInsights.computedAt))
    .limit(50);

  async function runNow() {
    "use server";
    const u = await requireTeamUser();
    await createAiJob(u.tenantId, null, "process_intelligence", {});
    revalidatePath("/process-intelligence");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Process Intelligence Engine</h1>
          <p className="text-sm text-muted-foreground">
            Operational bottlenecks found in CRM funnels, ticket SLAs, task cycle times and rework —
            the non-marketing advisory layer. Runs automatically every day.
          </p>
        </div>
        <form action={formAction(runNow)}>
          <Button variant="outline">Run analysis now</Button>
        </form>
      </div>

      <div className="space-y-3">
        {rows.map(({ insight: ins, clientName }) => (
          <Card key={ins.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle className="text-base">{ins.title}</CardTitle>
                <CardDescription>
                  {clientName ?? "agency-wide"} · {ins.computedAt.toISOString().slice(0, 10)}
                </CardDescription>
              </div>
              <Badge variant={ins.severity === "high" ? "destructive" : ins.severity === "medium" ? "warning" : "secondary"}>
                {ins.insightType.replace(/_/g, " ")} · {ins.severity}
              </Badge>
            </CardHeader>
            <CardContent>
              <p className="text-sm">{ins.finding}</p>
              <p className="mt-2 text-sm"><strong>Recommended action:</strong> {ins.recommendedAction}</p>
              <div className="mt-2 flex items-center gap-2">
                <ConfidenceBadge
                  score={ins.confidenceScore}
                  evidenceCount={ins.evidenceCount}
                  sources={ins.dataSources as string[]}
                />
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground">Evidence data</summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                  {JSON.stringify(ins.evidence, null, 2)}
                </pre>
              </details>
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No insights yet. The engine needs CRM and operational data flowing (leads, deals,
            tickets, tasks) — connect a CRM integration and let a daily run complete.
          </p>
        )}
      </div>
    </div>
  );
}
