"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, integrations, clients } from "@growengine/db";
import {
  audit,
  encryptJson,
  enqueueIntegrationJob,
  publishEvent,
  EVENT_TYPES,
  listProviders,
} from "@growengine/core";
import { requirePermission } from "@/lib/session";

const integrationSchema = z.object({
  clientId: z.string().uuid(),
  provider: z.string(),
  name: z.string().min(2).max(120),
  externalAccountId: z.string().min(1).max(200),
  /** JSON credential blob, shape varies by provider */
  credentialsJson: z.string().min(2),
  syncFrequencyMinutes: z.coerce.number().int().min(15).max(10080).default(360),
});

export async function createIntegration(formData: FormData) {
  const user = await requirePermission("integrations:manage");
  const parsed = integrationSchema.safeParse({
    clientId: formData.get("clientId"),
    provider: formData.get("provider"),
    name: formData.get("name"),
    externalAccountId: formData.get("externalAccountId"),
    credentialsJson: formData.get("credentialsJson"),
    syncFrequencyMinutes: formData.get("syncFrequencyMinutes") || 360,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (!listProviders().includes(parsed.data.provider)) {
    return { error: `Unsupported provider. Available: ${listProviders().join(", ")}` };
  }

  let credentials: Record<string, string>;
  try {
    credentials = JSON.parse(parsed.data.credentialsJson);
  } catch {
    return { error: "Credentials must be valid JSON (e.g. {\"accessToken\": \"...\"})" };
  }

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, parsed.data.clientId), eq(clients.tenantId, user.tenantId)));
  if (!client) return { error: "Client not found" };

  const [integration] = await db
    .insert(integrations)
    .values({
      tenantId: user.tenantId,
      clientId: client.id,
      provider: parsed.data.provider as never,
      name: parsed.data.name,
      externalAccountId: parsed.data.externalAccountId,
      encryptedCredentials: encryptJson(credentials),
      status: "connected",
      syncFrequencyMinutes: parsed.data.syncFrequencyMinutes,
    })
    .returning();

  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "integration.create",
    entityType: "integration",
    entityId: integration.id,
    changes: { provider: integration.provider, name: integration.name },
  });
  await publishEvent({
    tenantId: user.tenantId,
    eventType: EVENT_TYPES.integrationConnected,
    entityType: "integration",
    entityId: integration.id,
    payload: { provider: integration.provider, clientId: client.id },
  });

  // Verify credentials + run the first sync immediately (in the worker)
  await enqueueIntegrationJob({
    tenantId: user.tenantId,
    integrationId: integration.id,
    operation: "health_check",
  });
  await enqueueIntegrationJob({
    tenantId: user.tenantId,
    integrationId: integration.id,
    operation: "sync",
  });

  revalidatePath("/integrations");
  revalidatePath(`/clients/${client.id}`);
  return { ok: true, integrationId: integration.id };
}

export async function triggerSync(integrationId: string) {
  const user = await requirePermission("integrations:manage");
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.tenantId, user.tenantId)));
  if (!integration) return { error: "Integration not found" };

  await enqueueIntegrationJob({
    tenantId: user.tenantId,
    integrationId,
    operation: "sync",
  });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "integration.trigger_sync",
    entityType: "integration",
    entityId: integrationId,
  });
  revalidatePath("/integrations");
  return { ok: true };
}

export async function triggerBackfill(integrationId: string, days: number) {
  const user = await requirePermission("integrations:manage");
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, integrationId), eq(integrations.tenantId, user.tenantId)));
  if (!integration) return { error: "Integration not found" };

  const since = new Date(Date.now() - Math.min(days, 365) * 86400_000)
    .toISOString()
    .slice(0, 10);
  await enqueueIntegrationJob({
    tenantId: user.tenantId,
    integrationId,
    operation: "backfill",
    options: { since },
  });
  revalidatePath("/integrations");
  return { ok: true };
}

export async function disconnectIntegration(integrationId: string) {
  const user = await requirePermission("integrations:manage");
  await db
    .update(integrations)
    .set({ status: "disconnected", encryptedCredentials: null, updatedAt: new Date() })
    .where(and(eq(integrations.id, integrationId), eq(integrations.tenantId, user.tenantId)));
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "integration.disconnect",
    entityType: "integration",
    entityId: integrationId,
  });
  revalidatePath("/integrations");
  return { ok: true };
}
