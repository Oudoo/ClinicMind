import { formAction } from "@/lib/utils";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, knowledgeDocuments, decisions, clients } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createKnowledgeNote } from "@/app/actions/intelligence";
import { recommendationHistory } from "@growengine/core";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AomSearch } from "./search";

/**
 * Agency Operating Memory — semantic search over everything, the decision
 * log, and the canonical historical query (recommendations → decisions →
 * impact per client).
 */
export default async function AomPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientFilter } = await searchParams;
  const user = await requireTeamUser();

  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, user.tenantId));
  const docs = await db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.tenantId, user.tenantId))
    .orderBy(desc(knowledgeDocuments.createdAt))
    .limit(25);
  const decisionRows = await db
    .select()
    .from(decisions)
    .where(eq(decisions.tenantId, user.tenantId))
    .orderBy(desc(decisions.decidedAt))
    .limit(15);

  const history = clientFilter
    ? await recommendationHistory(user.tenantId, clientFilter, 18)
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agency Operating Memory</h1>
        <p className="text-sm text-muted-foreground">
          Everything the agency knows — meetings, reports, decisions, recommendations — linked and
          semantically searchable.
        </p>
      </div>

      <AomSearch clients={clientRows.map((c) => ({ id: c.id, name: c.name }))} />

      <Card>
        <CardHeader>
          <CardTitle>Historical context query</CardTitle>
          <CardDescription>
            &ldquo;Show every recommendation we made to this client in the last 18 months, which were
            approved, and their impact.&rdquo;
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="mb-3 flex items-end gap-2" method="GET">
            <div className="w-72">
              <Label>Client</Label>
              <Select name="client" defaultValue={clientFilter ?? ""}>
                <option value="">Select client…</option>
                {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
            <Button type="submit" variant="outline">Run query</Button>
          </form>
          {history && (
            <div className="space-y-2">
              {history.map((rec) => (
                <div key={rec.id} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{rec.title}</span>
                    <div className="flex gap-1.5">
                      <Badge variant={statusVariant(rec.status)}>{rec.status}</Badge>
                      {rec.decision && (
                        <Badge variant={statusVariant(rec.decision.outcome)}>
                          decision: {rec.decision.outcome}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {rec.createdAt.toISOString().slice(0, 10)}
                    {rec.confidenceScore ? ` · ${Number(rec.confidenceScore).toFixed(0)}% confidence · ${rec.evidenceCount} evidence` : ""}
                    {Object.keys(rec.measuredImpact as object).length > 0 &&
                      ` · impact: ${JSON.stringify(rec.measuredImpact)}`}
                  </div>
                </div>
              ))}
              {history.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">No recommendations in the window.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          <h2 className="font-semibold">Recent knowledge documents</h2>
          {docs.map((doc) => (
            <Link key={doc.id} href={`/aom/doc/${doc.id}`} className="flex items-center justify-between rounded-md border bg-card px-4 py-2.5 hover:bg-muted/50">
              <div>
                <div className="text-sm font-medium">{doc.title}</div>
                <div className="text-xs text-muted-foreground">{doc.createdAt.toISOString().slice(0, 10)}</div>
              </div>
              <Badge variant="outline">{doc.type}</Badge>
            </Link>
          ))}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Add note to memory</CardTitle></CardHeader>
            <CardContent>
              <form action={formAction(createKnowledgeNote)} className="space-y-3">
                <div>
                  <Label>Client</Label>
                  <Select name="clientId">
                    <option value="">Agency-wide</option>
                    {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Title</Label>
                  <Input name="title" required />
                </div>
                <div>
                  <Label>Content (markdown)</Label>
                  <Textarea name="content" rows={5} required />
                </div>
                <Button type="submit" className="w-full">Save & index</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Decision log</CardTitle></CardHeader>
            <CardContent className="space-y-1.5">
              {decisionRows.map((d) => (
                <div key={d.id} className="rounded-md border px-3 py-1.5 text-xs">
                  <div className="font-medium">{d.title}</div>
                  <div className="text-muted-foreground">
                    <Badge variant={statusVariant(d.outcome)} className="text-[10px]">{d.outcome}</Badge>{" "}
                    {d.approvedByName} · {d.decidedAt.toISOString().slice(0, 10)}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
