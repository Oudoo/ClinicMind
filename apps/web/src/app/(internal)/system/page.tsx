import { desc, eq } from "drizzle-orm";
import { db, queueJobs, domainEvents, auditLogs, backupRecords } from "@growengine/db";
import { getSystemHealth } from "@growengine/core";
import { requireTeamUser } from "@/lib/session";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

/** System Health Dashboard — workers, queues, DB/Redis, events, audit. */
export default async function SystemPage() {
  const user = await requireTeamUser();
  const health = await getSystemHealth();

  const failedJobs = await db
    .select()
    .from(queueJobs)
    .where(eq(queueJobs.status, "failed"))
    .orderBy(desc(queueJobs.enqueuedAt))
    .limit(10);

  const recentEvents = await db
    .select()
    .from(domainEvents)
    .where(eq(domainEvents.tenantId, user.tenantId))
    .orderBy(desc(domainEvents.occurredAt))
    .limit(15);

  const recentAudit = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.tenantId, user.tenantId))
    .orderBy(desc(auditLogs.createdAt))
    .limit(15);

  const backups = await db
    .select()
    .from(backupRecords)
    .orderBy(desc(backupRecords.startedAt))
    .limit(5);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">System Health</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <CardContent className="pt-5">
            <div className="text-sm text-muted-foreground">PostgreSQL</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={health.database.ok ? "success" : "destructive"}>
                {health.database.ok ? "healthy" : "down"}
              </Badge>
              <span className="text-sm text-muted-foreground">{health.database.latencyMs}ms</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-sm text-muted-foreground">Redis</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={health.redis.ok ? "success" : "destructive"}>
                {health.redis.ok ? "healthy" : "down"}
              </Badge>
              <span className="text-sm text-muted-foreground">{health.redis.latencyMs}ms</span>
            </div>
          </CardContent>
        </Card>
        <Card className="col-span-2">
          <CardContent className="pt-5">
            <div className="text-sm text-muted-foreground">Workers</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {health.workers.map((w) => (
                <Badge key={w.name} variant={w.healthy ? "success" : "destructive"}>
                  {w.name} {w.healthy ? "●" : "○"}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Queues</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead>Waiting</TableHead>
                <TableHead>Active</TableHead>
                <TableHead>Delayed</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Failed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(health.queues).map(([name, stats]) => (
                <TableRow key={name}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell>{stats.waiting}</TableCell>
                  <TableCell>{stats.active}</TableCell>
                  <TableCell>{stats.delayed}</TableCell>
                  <TableCell className="text-emerald-600">{stats.completed}</TableCell>
                  <TableCell className={stats.failed > 0 ? "text-destructive font-medium" : ""}>
                    {stats.failed}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Failed jobs</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {failedJobs.map((j) => (
              <div key={j.id} className="rounded-md border border-red-200 px-3 py-2 text-sm">
                <div className="font-medium">{j.queueName} / {j.jobName}</div>
                <div className="text-xs text-destructive">{j.error?.slice(0, 200)}</div>
              </div>
            ))}
            {failedJobs.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">No failed jobs 🎉</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Domain events</CardTitle>
            <CardDescription>The event bus feed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentEvents.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                <span className="font-mono text-xs">{e.eventType}</span>
                <span className="text-xs text-muted-foreground">
                  <Badge variant={statusVariant(e.dispatchStatus)} className="text-[10px]">{e.dispatchStatus}</Badge>{" "}
                  {e.occurredAt.toISOString().slice(11, 19)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Audit trail</CardTitle>
            <CardDescription>Immutable record of every significant action.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentAudit.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                <span className="font-mono text-xs">{a.action}</span>
                <span className="text-xs text-muted-foreground">
                  {a.actorType} · {a.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Backups</CardTitle>
            <CardDescription>Daily Postgres + storage backups via scripts/backup.sh (cron).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {backups.map((b) => (
              <div key={b.id} className="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm">
                <span>{b.backupType}</span>
                <span className="text-xs text-muted-foreground">
                  <Badge variant={statusVariant(b.status)} className="text-[10px]">{b.status}</Badge>{" "}
                  {b.startedAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </div>
            ))}
            {backups.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No backup runs recorded yet — schedule scripts/backup.sh in cron on the server.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
