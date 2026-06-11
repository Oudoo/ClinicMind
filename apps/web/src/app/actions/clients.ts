"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, clients, projects } from "@growengine/db";
import { audit, publishEvent, EVENT_TYPES } from "@growengine/core";
import { requirePermission } from "@/lib/session";
import { slugify } from "@/lib/utils";

const clientSchema = z.object({
  name: z.string().min(2).max(120),
  industry: z.string().max(80).optional(),
  websiteUrl: z.string().url().optional().or(z.literal("")),
  monthlyRetainer: z.coerce.number().nonnegative().optional(),
});

export async function createClient(formData: FormData) {
  const user = await requirePermission("clients:manage");
  const parsed = clientSchema.safeParse({
    name: formData.get("name"),
    industry: formData.get("industry") || undefined,
    websiteUrl: formData.get("websiteUrl") || "",
    monthlyRetainer: formData.get("monthlyRetainer") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const slug = slugify(parsed.data.name);
  const [existing] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, user.tenantId), eq(clients.slug, slug)));
  if (existing) return { error: "A client with this name already exists." };

  const [client] = await db
    .insert(clients)
    .values({
      tenantId: user.tenantId,
      name: parsed.data.name,
      slug,
      industry: parsed.data.industry,
      websiteUrl: parsed.data.websiteUrl || null,
      monthlyRetainer: parsed.data.monthlyRetainer?.toString(),
      accountManagerId: user.id,
      status: "onboarding",
    })
    .returning();

  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "client.create",
    entityType: "client",
    entityId: client.id,
    changes: { name: client.name },
  });
  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.clientCreated,
    entityType: "client",
    entityId: client.id,
    payload: { clientId: client.id, name: client.name },
  });

  revalidatePath("/clients");
  return { ok: true, clientId: client.id };
}

export async function updateClientStatus(clientId: string, status: string) {
  const user = await requirePermission("clients:manage");
  const allowed = ["prospect", "onboarding", "active", "paused", "offboarded"];
  if (!allowed.includes(status)) return { error: "Invalid status" };
  await db
    .update(clients)
    .set({ status: status as never, updatedAt: new Date() })
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, user.tenantId)));
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "client.update_status",
    entityType: "client",
    entityId: clientId,
    changes: { status },
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

const milestoneSchema = z.object({
  label: z.string().min(2).max(120),
  metric: z.string().min(1),
  target: z.coerce.number().positive(),
});

export async function addMilestoneTarget(clientId: string, formData: FormData) {
  const user = await requirePermission("clients:manage");
  const parsed = milestoneSchema.safeParse({
    label: formData.get("label"),
    metric: formData.get("metric"),
    target: formData.get("target"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  const targets = (client.milestoneTargets as unknown[]) ?? [];
  targets.push(parsed.data);
  await db
    .update(clients)
    .set({ milestoneTargets: targets, updatedAt: new Date() })
    .where(eq(clients.id, clientId));
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function createProject(clientId: string, formData: FormData) {
  const user = await requirePermission("clients:manage");
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Project name required" };
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  await db.insert(projects).values({
    tenantId: user.tenantId,
    clientId,
    name,
    description: String(formData.get("description") ?? "") || null,
    ownerId: user.id,
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
