import { formAction } from "@/lib/utils";
import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, meetings, clients, prerequisiteForms } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createMeeting, createPrerequisiteForm } from "@/app/actions/meetings";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

export default async function MeetingsPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({ meeting: meetings, clientName: clients.name })
    .from(meetings)
    .innerJoin(clients, eq(meetings.clientId, clients.id))
    .where(eq(meetings.tenantId, user.tenantId))
    .orderBy(desc(meetings.createdAt))
    .limit(50);
  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, user.tenantId));
  const forms = await db
    .select()
    .from(prerequisiteForms)
    .where(eq(prerequisiteForms.tenantId, user.tenantId));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Meeting Intelligence</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {rows.map(({ meeting: m, clientName }) => (
            <Link key={m.id} href={`/meetings/${m.id}`} className="flex items-center justify-between rounded-md border bg-card px-4 py-3 hover:bg-muted/50">
              <div>
                <div className="text-sm font-medium">{m.title}</div>
                <div className="text-xs text-muted-foreground">
                  {clientName} · {m.scheduledAt ? m.scheduledAt.toISOString().replace("T", " ").slice(0, 16) : "unscheduled"}
                  {m.analysisConfidence ? ` · analysis confidence ${Number(m.analysisConfidence).toFixed(0)}%` : ""}
                </div>
              </div>
              <Badge variant={statusVariant(m.status)}>{m.status.replace(/_/g, " ")}</Badge>
            </Link>
          ))}
          {rows.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Pipeline: prerequisites form → record → Whisper transcription → requirement extraction → Expectation Baseline → SOW.
            </p>
          )}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Schedule meeting</CardTitle></CardHeader>
            <CardContent>
              <form action={formAction(createMeeting)} className="space-y-3">
                <div>
                  <Label>Client</Label>
                  <Select name="clientId" required>
                    {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Title</Label>
                  <Input name="title" required />
                </div>
                <div>
                  <Label>When</Label>
                  <Input name="scheduledAt" type="datetime-local" />
                </div>
                <div>
                  <Label>Agenda</Label>
                  <Textarea name="agenda" rows={3} />
                </div>
                <Button type="submit" className="w-full">Create meeting</Button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Prerequisite forms</CardTitle>
              <CardDescription>{forms.length} active template(s) — global or client-specific.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction(createPrerequisiteForm)} className="space-y-3">
                <div>
                  <Label>Form name</Label>
                  <Input name="name" placeholder="Discovery prerequisites" required />
                </div>
                <div>
                  <Label>Scope</Label>
                  <Select name="clientId">
                    <option value="">Global (all clients)</option>
                    {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Fields (JSON)</Label>
                  <Textarea
                    name="fieldsJson"
                    rows={4}
                    defaultValue='[{"key":"goals","label":"Top 3 business goals","type":"textarea","required":true},{"key":"budget","label":"Monthly budget","type":"text","required":true},{"key":"blockers","label":"Current blockers","type":"textarea","required":false}]'
                  />
                </div>
                <Button type="submit" variant="outline" className="w-full">Save template</Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
