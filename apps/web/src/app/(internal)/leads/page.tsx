import { desc, eq } from "drizzle-orm";
import { db, leadAudits } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";

export default async function LeadsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select()
    .from(leadAudits)
    .where(eq(leadAudits.tenantId, user.tenantId))
    .orderBy(desc(leadAudits.createdAt))
    .limit(50);

  const widgetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/audit?tenant=${user.tenantSlug}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lead Audits</h1>
        <p className="text-sm text-muted-foreground">
          Prospects from the Interactive Business Audit widget. Embed it:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            &lt;iframe src=&quot;{widgetUrl}&quot; width=&quot;100%&quot; height=&quot;760&quot;&gt;&lt;/iframe&gt;
          </code>
        </p>
      </div>

      <div className="space-y-3">
        {rows.map((lead) => (
          <Card key={lead.id}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div>
                <CardTitle>{lead.companyName}</CardTitle>
                <CardDescription>
                  {lead.contactName} · {lead.contactEmail} · {lead.websiteUrl}
                  {lead.monthlyAdBudget ? ` · budget ${lead.monthlyAdBudget}` : ""}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {lead.auditScore && (
                  <span className="text-xl font-bold">{Number(lead.auditScore).toFixed(0)}/100</span>
                )}
                <Badge variant={statusVariant(lead.status)}>{lead.status}</Badge>
              </div>
            </CardHeader>
            {lead.status === "completed" && lead.auditReport && (
              <CardContent>
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-primary">View generated audit</summary>
                  <div className="mt-3"><Markdown content={lead.auditReport} /></div>
                </details>
              </CardContent>
            )}
          </Card>
        ))}
        {rows.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No lead audits yet — share or embed the widget to start capturing prospects.
          </p>
        )}
      </div>
    </div>
  );
}
