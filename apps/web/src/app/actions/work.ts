"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql as dsql } from "drizzle-orm";
import { db, tickets, tasks, subTasks, comments, clients, sprintShowcases } from "@growengine/db";
import { audit, publishEvent, EVENT_TYPES, uploadObject } from "@growengine/core";
import { requirePermission, requireUser } from "@/lib/session";
import { createAiJob } from "@/lib/jobs";

const ticketSchema = z.object({
  clientId: z.string().uuid().optional().or(z.literal("")),
  subject: z.string().min(4).max(250),
  description: z.string().max(20000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  slaHours: z.coerce.number().int().min(1).max(720).optional(),
});

export async function createTicket(formData: FormData) {
  const user = await requireUser();
  const parsed = ticketSchema.safeParse({
    clientId: formData.get("clientId") || "",
    subject: formData.get("subject"),
    description: formData.get("description") || undefined,
    priority: formData.get("priority") ?? "medium",
    slaHours: formData.get("slaHours") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  // Portal users always file against their own client
  const clientId = user.clientId ?? (parsed.data.clientId || null);
  if (clientId) {
    const [client] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.tenantId, user.tenantId)));
    if (!client) return { error: "Client not found" };
  }

  const [{ next }] = await db
    .select({ next: dsql<number>`COALESCE(MAX(${tickets.number}), 0) + 1` })
    .from(tickets)
    .where(eq(tickets.tenantId, user.tenantId));

  const [ticket] = await db
    .insert(tickets)
    .values({
      tenantId: user.tenantId,
      clientId,
      number: Number(next),
      subject: parsed.data.subject,
      description: parsed.data.description,
      priority: parsed.data.priority,
      requesterId: user.id,
      slaDueAt: parsed.data.slaHours
        ? new Date(Date.now() + parsed.data.slaHours * 3600_000)
        : new Date(Date.now() + (parsed.data.priority === "urgent" ? 4 : parsed.data.priority === "high" ? 24 : 72) * 3600_000),
    })
    .returning();

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.ticketCreated,
    entityType: "ticket",
    entityId: ticket.id,
    payload: { clientId, subject: ticket.subject, priority: ticket.priority },
  });
  if (clientId) {
    await createAiJob(user.tenantId, clientId, "embedding", {
      entityType: "ticket",
      entityId: ticket.id,
      clientId,
    });
  }
  revalidatePath("/tickets");
  return { ok: true, ticketId: ticket.id };
}

export async function updateTicketStatus(ticketId: string, status: string) {
  const user = await requirePermission("work:manage");
  const allowed = ["open", "in_progress", "waiting_on_client", "resolved", "closed"];
  if (!allowed.includes(status)) return { error: "Invalid status" };

  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.tenantId, user.tenantId)));
  if (!ticket) return { error: "Ticket not found" };

  await db
    .update(tickets)
    .set({
      status: status as never,
      assigneeId: ticket.assigneeId ?? user.id,
      firstResponseAt: ticket.firstResponseAt ?? new Date(),
      resolvedAt: status === "resolved" || status === "closed" ? new Date() : ticket.resolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(tickets.id, ticketId));

  if ((status === "resolved" || status === "closed") && ticket.slaDueAt && new Date() > ticket.slaDueAt) {
    await publishEvent({
      tenantId: user.tenantId,
      eventType: EVENT_TYPES.ticketSlaBreached,
      entityType: "ticket",
      entityId: ticketId,
      payload: { subject: ticket.subject, clientId: ticket.clientId },
    });
  }
  revalidatePath("/tickets");
  return { ok: true };
}

export async function addComment(entityType: string, entityId: string, formData: FormData) {
  const user = await requireUser();
  const body = String(formData.get("body") ?? "").trim();
  if (body.length < 1) return { error: "Comment cannot be empty" };

  await db.insert(comments).values({
    tenantId: user.tenantId,
    entityType,
    entityId,
    authorId: user.id,
    body,
    isInternal: user.clientId ? 0 : Number(formData.get("internal") === "on"),
  });

  // First team response on a ticket stamps SLA first-response
  if (entityType === "ticket" && !user.clientId) {
    await db
      .update(tickets)
      .set({ firstResponseAt: dsql`COALESCE(${tickets.firstResponseAt}, NOW())` })
      .where(and(eq(tickets.id, entityId), eq(tickets.tenantId, user.tenantId)));
  }
  revalidatePath("/tickets");
  return { ok: true };
}

const taskSchema = z.object({
  clientId: z.string().uuid().optional().or(z.literal("")),
  title: z.string().min(2).max(250),
  description: z.string().max(10000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  dueDate: z.string().optional(),
  estimateHours: z.coerce.number().positive().max(1000).optional(),
});

export async function createTask(formData: FormData) {
  const user = await requirePermission("work:manage");
  const parsed = taskSchema.safeParse({
    clientId: formData.get("clientId") || "",
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    priority: formData.get("priority") ?? "medium",
    dueDate: formData.get("dueDate") || undefined,
    estimateHours: formData.get("estimateHours") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await db.insert(tasks).values({
    tenantId: user.tenantId,
    clientId: parsed.data.clientId || null,
    title: parsed.data.title,
    description: parsed.data.description,
    priority: parsed.data.priority,
    assigneeId: user.id,
    dueDate: parsed.data.dueDate || null,
    estimateHours: parsed.data.estimateHours?.toString(),
  });
  revalidatePath("/tasks");
  return { ok: true };
}

export async function updateTaskStatus(taskId: string, status: string) {
  const user = await requirePermission("work:manage");
  const allowed = ["todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
  if (!allowed.includes(status)) return { error: "Invalid status" };

  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, user.tenantId)));
  if (!task) return { error: "Task not found" };

  const reopened = task.status === "done" && status !== "done";
  await db
    .update(tasks)
    .set({
      status: status as never,
      startedAt: task.startedAt ?? (status === "in_progress" ? new Date() : null),
      completedAt: status === "done" ? new Date() : null,
      reworkCount: reopened ? task.reworkCount + 1 : task.reworkCount,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));

  if (status === "done") {
    await publishEvent({
      tenantId: user.tenantId,
      eventType: EVENT_TYPES.taskCompleted,
      entityType: "task",
      entityId: taskId,
      payload: { title: task.title, clientId: task.clientId },
    });
  }
  revalidatePath("/tasks");
  return { ok: true };
}

export async function addSubTask(taskId: string, formData: FormData) {
  const user = await requirePermission("work:manage");
  const title = String(formData.get("title") ?? "").trim();
  if (title.length < 2) return { error: "Subtask title required" };
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, user.tenantId)));
  if (!task) return { error: "Task not found" };
  await db.insert(subTasks).values({ tenantId: user.tenantId, taskId, title });
  revalidatePath("/tasks");
  return { ok: true };
}

const showcaseSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  summary: z.string().max(5000).optional(),
  sprintStart: z.string().optional(),
  sprintEnd: z.string().optional(),
});

/** Publish a bi-weekly sprint video showcase to the client portal. */
export async function publishShowcase(formData: FormData) {
  const user = await requirePermission("clients:manage");
  const parsed = showcaseSchema.safeParse({
    clientId: formData.get("clientId"),
    title: formData.get("title"),
    summary: formData.get("summary") || undefined,
    sprintStart: formData.get("sprintStart") || undefined,
    sprintEnd: formData.get("sprintEnd") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, parsed.data.clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  let videoStorageKey: string | null = null;
  const file = formData.get("video") as File | null;
  if (file && file.size > 0) {
    if (file.size > 1024 * 1024 * 1024) return { error: "Video exceeds 1GB limit" };
    const ext = file.name.split(".").pop() ?? "mp4";
    videoStorageKey = `${user.tenantId}/showcases/${crypto.randomUUID()}.${ext}`;
    await uploadObject(videoStorageKey, Buffer.from(await file.arrayBuffer()), file.type || "video/mp4");
  }

  const [showcase] = await db
    .insert(sprintShowcases)
    .values({
      tenantId: user.tenantId,
      clientId: client.id,
      title: parsed.data.title,
      summary: parsed.data.summary,
      videoStorageKey,
      sprintStart: parsed.data.sprintStart || null,
      sprintEnd: parsed.data.sprintEnd || null,
      publishedAt: new Date(),
      createdBy: user.id,
    })
    .returning();

  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.showcasePublished,
    entityType: "sprint_showcase",
    entityId: showcase.id,
    payload: { clientId: client.id, title: showcase.title },
  });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "showcase.publish",
    entityType: "sprint_showcase",
    entityId: showcase.id,
  });
  revalidatePath(`/clients/${client.id}`);
  return { ok: true };
}
