import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, tickets, clients, comments } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createTicket, updateTicketStatus, addComment } from "@/app/actions/work";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

export default async function TicketsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({ ticket: tickets, clientName: clients.name })
    .from(tickets)
    .leftJoin(clients, eq(tickets.clientId, clients.id))
    .where(eq(tickets.tenantId, user.tenantId))
    .orderBy(desc(tickets.createdAt))
    .limit(50);
  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, user.tenantId));
  const allComments = await db
    .select()
    .from(comments)
    .where(eq(comments.tenantId, user.tenantId))
    .orderBy(desc(comments.createdAt))
    .limit(200);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tickets</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {rows.map(({ ticket: t, clientName }) => {
            const ticketComments = allComments.filter(
              (c) => c.entityType === "ticket" && c.entityId === t.id
            );
            const slaBreached = t.slaDueAt && !t.resolvedAt && new Date() > t.slaDueAt;
            return (
              <Card key={t.id}>
                <CardContent className="pt-5">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="text-xs text-muted-foreground">#{t.number}</span>{" "}
                      <span className="font-medium">{t.subject}</span>
                      <div className="text-xs text-muted-foreground">
                        {clientName ?? "internal"} · {t.priority}
                        {t.slaDueAt && (
                          <span className={slaBreached ? "text-destructive font-medium" : ""}>
                            {" "}· SLA {slaBreached ? "BREACHED" : `due ${t.slaDueAt.toISOString().slice(0, 16).replace("T", " ")}`}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={statusVariant(t.status)}>{t.status.replace(/_/g, " ")}</Badge>
                      {t.status !== "closed" && (
                        <form action={formAction(updateTicketStatus.bind(null, t.id, t.status === "resolved" ? "closed" : t.status === "open" ? "in_progress" : "resolved"))}>
                          <Button size="sm" variant="outline">
                            {t.status === "resolved" ? "Close" : t.status === "open" ? "Start" : "Resolve"}
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>
                  {t.description && <p className="mt-2 text-sm text-muted-foreground">{t.description}</p>}
                  {ticketComments.length > 0 && (
                    <div className="mt-3 space-y-1 border-t pt-2">
                      {ticketComments.slice(0, 3).map((c) => (
                        <div key={c.id} className="text-xs">
                          <span className="text-muted-foreground">{c.createdAt.toISOString().slice(0, 16).replace("T", " ")}:</span> {c.body}
                          {c.isInternal === 1 && <Badge variant="outline" className="ml-1">internal</Badge>}
                        </div>
                      ))}
                    </div>
                  )}
                  <form action={formAction(addComment.bind(null, "ticket", t.id))} className="mt-2 flex gap-2">
                    <Input name="body" placeholder="Reply…" className="flex-1" />
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input type="checkbox" name="internal" /> internal
                    </label>
                    <Button type="submit" size="sm" variant="outline">Send</Button>
                  </form>
                </CardContent>
              </Card>
            );
          })}
          {rows.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">No tickets.</p>}
        </div>
        <Card className="h-fit">
          <CardHeader><CardTitle>New ticket</CardTitle></CardHeader>
          <CardContent>
            <form action={formAction(createTicket)} className="space-y-3">
              <div>
                <Label>Client</Label>
                <Select name="clientId">
                  <option value="">Internal</option>
                  {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label>Subject</Label>
                <Input name="subject" required />
              </div>
              <div>
                <Label>Priority</Label>
                <Select name="priority">
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </Select>
              </div>
              <div>
                <Label>Description</Label>
                <Textarea name="description" rows={4} />
              </div>
              <Button type="submit" className="w-full">Create ticket</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
