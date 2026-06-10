import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, integrations, integrationLogs, clients } from "@growengine/db";
import { listProviders } from "@growengine/core";
import { requireTeamUser } from "@/lib/session";
import { createIntegration, triggerSync, triggerBackfill, disconnectIntegration } from "@/app/actions/integrations";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Integration Health Center — last sync, failures, token expiry and quota
 * posture for every connected data source.
 */
export default async function IntegrationsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({
      integration: integrations,
      clientName: clients.name,
    })
    .from(integrations)
    .innerJoin(clients, eq(integrations.clientId, clients.id))
    .where(eq(integrations.tenantId, user.tenantId))
    .orderBy(desc(integrations.updatedAt));

  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, user.tenantId));
  const recentLogs = await db
    .select()
    .from(integrationLogs)
    .where(eq(integrationLogs.tenantId, user.tenantId))
    .orderBy(desc(integrationLogs.startedAt))
    .limit(15);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Integration Health Center</h1>

      <Card>
        <CardContent className="pt-5">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Integration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead>Failures</TableHead>
                <TableHead>Token expiry</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ integration: i, clientName }) => (
                <TableRow key={i.id}>
                  <TableCell>
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs text-muted-foreground">{i.provider} · {clientName}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(i.status)}>{i.status.replace(/_/g, " ")}</Badge>
                    {i.lastError && <div className="mt-1 max-w-56 truncate text-xs text-destructive" title={i.lastError}>{i.lastError}</div>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {i.lastSuccessfulSyncAt ? i.lastSuccessfulSyncAt.toISOString().replace("T", " ").slice(0, 16) : "never"}
                  </TableCell>
                  <TableCell>
                    {i.consecutiveFailures > 0 ? (
                      <span className="text-destructive">{i.consecutiveFailures} consecutive</span>
                    ) : (
                      <span className="text-emerald-600">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {i.tokenExpiresAt ? (
                      <span className={i.tokenExpiresAt < new Date(Date.now() + 7 * 86400_000) ? "text-amber-600 font-medium" : ""}>
                        {i.tokenExpiresAt.toISOString().slice(0, 10)}
                      </span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1.5">
                      <form action={formAction(triggerSync.bind(null, i.id))}>
                        <Button size="sm" variant="outline">Sync now</Button>
                      </form>
                      <form action={formAction(triggerBackfill.bind(null, i.id, 90))}>
                        <Button size="sm" variant="ghost">Backfill 90d</Button>
                      </form>
                      <form action={formAction(disconnectIntegration.bind(null, i.id))}>
                        <Button size="sm" variant="ghost" className="text-destructive">Disconnect</Button>
                      </form>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No integrations connected yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Connect a data source</CardTitle>
            <CardDescription>
              Official APIs only. Credentials are AES-256-GCM encrypted at rest; the first sync and
              a connection probe queue immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={formAction(createIntegration)} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Client</Label>
                  <Select name="clientId" required>
                    {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Provider</Label>
                  <Select name="provider" required>
                    {listProviders().map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                </div>
              </div>
              <div>
                <Label>Display name</Label>
                <Input name="name" placeholder="Acme — Meta Ads (Main)" required />
              </div>
              <div>
                <Label>External account id (ad account / GA4 property / org…)</Label>
                <Input name="externalAccountId" required />
              </div>
              <div>
                <Label>Credentials (JSON — shape varies per provider)</Label>
                <Textarea name="credentialsJson" rows={3} placeholder='{"accessToken": "..."}' required />
              </div>
              <div>
                <Label>Sync frequency (minutes)</Label>
                <Input name="syncFrequencyMinutes" type="number" defaultValue={360} min={15} />
              </div>
              <Button type="submit" className="w-full">Connect & sync</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent sync runs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {recentLogs.map((log) => (
              <div key={log.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <Badge variant={statusVariant(log.status)}>{log.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {log.startedAt.toISOString().replace("T", " ").slice(0, 16)} · {log.durationMs ?? 0}ms
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {log.recordsStored}/{log.recordsFetched} records stored ·{" "}
                  {(log.apiRequestIds as string[]).length} API request ids captured ·{" "}
                  {(log.sanityFindings as unknown[]).length} sanity findings
                </div>
                {log.error && <div className="mt-1 text-xs text-destructive">{log.error}</div>}
              </div>
            ))}
            {recentLogs.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No sync runs yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
