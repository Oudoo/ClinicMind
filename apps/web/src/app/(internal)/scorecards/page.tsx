import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, teamScorecards, users } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createAiJob } from "@/lib/jobs";
import { revalidatePath } from "next/cache";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function ScorecardsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({ card: teamScorecards, userName: users.name })
    .from(teamScorecards)
    .innerJoin(users, eq(teamScorecards.userId, users.id))
    .where(eq(teamScorecards.tenantId, user.tenantId))
    .orderBy(desc(teamScorecards.periodStart), desc(teamScorecards.computedAt))
    .limit(100);

  async function computeNow() {
    "use server";
    const u = await requireTeamUser();
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400_000);
    await createAiJob(u.tenantId, null, "scorecards", {
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
    });
    revalidatePath("/scorecards");
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Team Scorecards</h1>
          <p className="text-sm text-muted-foreground">
            Strictly objective metrics computed from tasks and tickets — delivery speed, SLA
            compliance, rework frequency. Never hand-edited.
          </p>
        </div>
        <form action={formAction(computeNow)}>
          <Button variant="outline">Compute trailing 30 days</Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scorecards</CardTitle>
          <CardDescription>Monthly cards are generated automatically on the 1st.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team member</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Tasks done</TableHead>
                <TableHead>On-time %</TableHead>
                <TableHead>Avg cycle (h)</TableHead>
                <TableHead>SLA %</TableHead>
                <TableHead>Rework %</TableHead>
                <TableHead>Tickets resolved</TableHead>
                <TableHead>First response (min)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ card, userName }) => (
                <TableRow key={card.id}>
                  <TableCell className="font-medium">{userName}</TableCell>
                  <TableCell className="text-xs">{card.periodStart} → {card.periodEnd}</TableCell>
                  <TableCell>{card.tasksCompleted}</TableCell>
                  <TableCell>
                    {card.tasksCompleted > 0
                      ? `${((card.tasksOnTime / card.tasksCompleted) * 100).toFixed(0)}%`
                      : "—"}
                  </TableCell>
                  <TableCell>{card.avgCycleTimeHours ?? "—"}</TableCell>
                  <TableCell>{card.slaCompliancePct ? `${Number(card.slaCompliancePct).toFixed(0)}%` : "—"}</TableCell>
                  <TableCell className={Number(card.reworkRatePct) > 20 ? "text-destructive" : ""}>
                    {card.reworkRatePct ? `${Number(card.reworkRatePct).toFixed(0)}%` : "0%"}
                  </TableCell>
                  <TableCell>{card.ticketsResolved}</TableCell>
                  <TableCell>{card.avgFirstResponseMinutes ? Number(card.avgFirstResponseMinutes).toFixed(0) : "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                    No scorecards yet — they require completed tasks/tickets in the period.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
