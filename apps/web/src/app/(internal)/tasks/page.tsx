import { formAction } from "@/lib/utils";
import { desc, eq } from "drizzle-orm";
import { db, tasks, subTasks, clients } from "@growengine/db";
import { requireTeamUser } from "@/lib/session";
import { createTask, updateTaskStatus, addSubTask } from "@/app/actions/work";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

const COLUMNS = ["todo", "in_progress", "in_review", "blocked", "done"] as const;

export default async function TasksPage() {
  const user = await requireTeamUser();
  const rows = await db
    .select({ task: tasks, clientName: clients.name })
    .from(tasks)
    .leftJoin(clients, eq(tasks.clientId, clients.id))
    .where(eq(tasks.tenantId, user.tenantId))
    .orderBy(desc(tasks.createdAt))
    .limit(200);
  const subs = await db.select().from(subTasks).where(eq(subTasks.tenantId, user.tenantId));
  const clientRows = await db.select().from(clients).where(eq(clients.tenantId, user.tenantId));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tasks</h1>

      <Card>
        <CardHeader><CardTitle>New task</CardTitle></CardHeader>
        <CardContent>
          <form action={formAction(createTask)} className="grid items-end gap-3 md:grid-cols-6">
            <div className="md:col-span-2">
              <Label>Title</Label>
              <Input name="title" required />
            </div>
            <div>
              <Label>Client</Label>
              <Select name="clientId">
                <option value="">Internal</option>
                {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
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
              <Label>Due date</Label>
              <Input name="dueDate" type="date" />
            </div>
            <Button type="submit">Add task</Button>
            <div className="md:col-span-6">
              <Textarea name="description" placeholder="Description (optional)" rows={2} />
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-5">
        {COLUMNS.map((col) => (
          <div key={col} className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-sm font-semibold capitalize">{col.replace(/_/g, " ")}</span>
              <span className="text-xs text-muted-foreground">
                {rows.filter((r) => r.task.status === col).length}
              </span>
            </div>
            {rows
              .filter((r) => r.task.status === col)
              .slice(0, 15)
              .map(({ task: t, clientName }) => {
                const taskSubs = subs.filter((s) => s.taskId === t.id);
                const nextStatus =
                  col === "todo" ? "in_progress" : col === "in_progress" ? "in_review" : col === "in_review" ? "done" : col === "blocked" ? "in_progress" : null;
                return (
                  <Card key={t.id}>
                    <CardContent className="p-3">
                      <div className="text-sm font-medium">{t.title}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {clientName ?? "internal"}
                        {t.dmaicPhase && <Badge variant="info" className="ml-1">DMAIC: {t.dmaicPhase}</Badge>}
                        {t.dueDate && ` · due ${t.dueDate}`}
                        {t.reworkCount > 0 && <span className="text-amber-600"> · rework ×{t.reworkCount}</span>}
                      </div>
                      {taskSubs.length > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {taskSubs.map((s) => (
                            <div key={s.id} className="text-xs text-muted-foreground">
                              {s.status === "done" ? "☑" : "☐"} {s.title}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-1.5">
                        {nextStatus && (
                          <form action={formAction(updateTaskStatus.bind(null, t.id, nextStatus))}>
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]">
                              → {nextStatus.replace(/_/g, " ")}
                            </Button>
                          </form>
                        )}
                        <Badge variant={statusVariant(t.priority)} className="text-[10px]">{t.priority}</Badge>
                      </div>
                      <form action={formAction(addSubTask.bind(null, t.id))} className="mt-2 flex gap-1">
                        <Input name="title" placeholder="+ subtask" className="h-6 text-xs" />
                        <Button type="submit" size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]">Add</Button>
                      </form>
                    </CardContent>
                  </Card>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
