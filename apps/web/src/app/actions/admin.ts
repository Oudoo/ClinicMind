"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq, sql as dsql } from "drizzle-orm";
import {
  db,
  tenantInvites,
  roles,
  apiKeys,
  dataRetentionPolicies,
  features,
  featureFlags,
  notificationTemplates,
  notificationRules,
  webhookEndpoints,
  invoices,
  subscriptions,
  usageRecords,
  featureRequests,
  votes,
  clients,
} from "@growengine/db";
import {
  audit,
  generateApiKey,
  generateToken,
  encryptSecret,
  notify,
  enqueueNotificationJob,
} from "@growengine/core";
import { requirePermission, requireUser } from "@/lib/session";

const inviteSchema = z.object({
  email: z.string().email(),
  roleId: z.string().uuid(),
  clientId: z.string().uuid().optional().or(z.literal("")),
});

export async function inviteUser(formData: FormData) {
  const user = await requirePermission("settings:admin");
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    roleId: formData.get("roleId"),
    clientId: formData.get("clientId") || "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, parsed.data.roleId), eq(roles.tenantId, user.tenantId)));
  if (!role) return { error: "Role not found" };

  if (parsed.data.clientId) {
    const [client] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, parsed.data.clientId), eq(clients.tenantId, user.tenantId)));
    if (!client) return { error: "Client not found" };
  }

  const token = generateToken();
  await db.insert(tenantInvites).values({
    tenantId: user.tenantId,
    email: parsed.data.email.toLowerCase(),
    roleId: role.id,
    clientId: parsed.data.clientId || null,
    token,
    invitedBy: user.id,
    expiresAt: new Date(Date.now() + 7 * 86400_000),
  });

  const inviteUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/accept-invite?token=${token}`;
  await notify({
    tenantId: user.tenantId,
    channel: "email",
    title: "You've been invited to The Grow Engine",
    body: `You've been invited to join the ${user.tenantSlug} workspace as ${role.name}.\n\nAccept your invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
    metadata: { email: parsed.data.email.toLowerCase() },
  });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "user.invite",
    changes: { email: parsed.data.email, role: role.name },
  });
  revalidatePath("/settings");
  return { ok: true, inviteUrl };
}

export async function createApiKey(formData: FormData) {
  const user = await requirePermission("settings:admin");
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Key name required" };

  const { raw, hash, prefix } = generateApiKey();
  await db.insert(apiKeys).values({
    tenantId: user.tenantId,
    name,
    keyHash: hash,
    keyPrefix: prefix,
    scopes: ["read"],
    createdBy: user.id,
  });
  await audit({ tenantId: user.tenantId, actorId: user.id, action: "api_key.create", changes: { name } });
  revalidatePath("/settings");
  // Raw key shown exactly once
  return { ok: true, apiKey: raw };
}

export async function revokeApiKey(keyId: string) {
  const user = await requirePermission("settings:admin");
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, user.tenantId)));
  await audit({ tenantId: user.tenantId, actorId: user.id, action: "api_key.revoke", entityId: keyId });
  revalidatePath("/settings");
  return { ok: true };
}

export async function updateRetentionPolicy(policyId: string, retentionDays: number) {
  const user = await requirePermission("settings:admin");
  if (retentionDays < 7 || retentionDays > 3650) return { error: "Retention must be 7–3650 days" };
  await db
    .update(dataRetentionPolicies)
    .set({ retentionDays, updatedAt: new Date() })
    .where(and(eq(dataRetentionPolicies.id, policyId), eq(dataRetentionPolicies.tenantId, user.tenantId)));
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "retention.update",
    entityId: policyId,
    changes: { retentionDays },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function toggleFeatureFlag(featureKey: string, enabled: boolean) {
  const user = await requirePermission("settings:admin");
  let [feature] = await db.select().from(features).where(eq(features.key, featureKey));
  if (!feature) {
    [feature] = await db
      .insert(features)
      .values({ key: featureKey, name: featureKey })
      .returning();
  }
  await db
    .insert(featureFlags)
    .values({ tenantId: user.tenantId, featureId: feature.id, enabled })
    .onConflictDoUpdate({
      target: [featureFlags.tenantId, featureFlags.featureId],
      set: { enabled, updatedAt: new Date() },
    });
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "feature_flag.toggle",
    changes: { featureKey, enabled },
  });
  revalidatePath("/settings");
  return { ok: true };
}

const templateSchema = z.object({
  key: z.string().min(2).max(80),
  name: z.string().min(2).max(120),
  subjectTemplate: z.string().min(2).max(300),
  bodyTemplate: z.string().min(2).max(10000),
});

export async function upsertNotificationTemplate(formData: FormData) {
  const user = await requirePermission("settings:admin");
  const parsed = templateSchema.safeParse({
    key: formData.get("key"),
    name: formData.get("name"),
    subjectTemplate: formData.get("subjectTemplate"),
    bodyTemplate: formData.get("bodyTemplate"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await db
    .insert(notificationTemplates)
    .values({ tenantId: user.tenantId, ...parsed.data })
    .onConflictDoUpdate({
      target: [notificationTemplates.tenantId, notificationTemplates.key],
      set: {
        name: parsed.data.name,
        subjectTemplate: parsed.data.subjectTemplate,
        bodyTemplate: parsed.data.bodyTemplate,
        updatedAt: new Date(),
      },
    });
  revalidatePath("/settings");
  return { ok: true };
}

const ruleSchema = z.object({
  eventType: z.string().min(2).max(120),
  templateKey: z.string().min(2).max(80),
  channels: z.string(),
  roleNames: z.string().optional(),
});

export async function createNotificationRule(formData: FormData) {
  const user = await requirePermission("settings:admin");
  const parsed = ruleSchema.safeParse({
    eventType: formData.get("eventType"),
    templateKey: formData.get("templateKey"),
    channels: formData.get("channels") ?? "in_app",
    roleNames: formData.get("roleNames") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await db.insert(notificationRules).values({
    tenantId: user.tenantId,
    eventType: parsed.data.eventType,
    templateKey: parsed.data.templateKey,
    channels: parsed.data.channels.split(",").map((c) => c.trim()),
    audience: parsed.data.roleNames
      ? { roles: parsed.data.roleNames.split(",").map((r) => r.trim()) }
      : {},
  });
  revalidatePath("/settings");
  return { ok: true };
}

export async function createWebhookEndpoint(formData: FormData) {
  const user = await requirePermission("settings:admin");
  const url = String(formData.get("url") ?? "");
  const eventTypes = String(formData.get("eventTypes") ?? "*");
  const secret = String(formData.get("secret") ?? "");
  if (!z.string().url().safeParse(url).success) return { error: "Valid URL required" };

  await db.insert(webhookEndpoints).values({
    tenantId: user.tenantId,
    url,
    eventTypes: eventTypes.split(",").map((e) => e.trim()),
    encryptedSecret: secret ? encryptSecret(secret) : null,
  });
  revalidatePath("/settings");
  return { ok: true };
}

/** Generate the current period invoice from the subscription + usage. */
export async function generateInvoice() {
  const user = await requirePermission("billing:admin");
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.tenantId, user.tenantId))
    .limit(1);
  if (!sub) return { error: "No subscription found" };

  const [{ aiTokens }] = await db
    .select({ aiTokens: dsql<string>`COALESCE(SUM(${usageRecords.quantity}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.tenantId, user.tenantId),
        eq(usageRecords.meter, "ai_tokens"),
        dsql`${usageRecords.usageDate} >= ${sub.currentPeriodStart}`
      )
    );

  const [{ count }] = await db
    .select({ count: dsql<string>`COUNT(*)` })
    .from(invoices)
    .where(eq(invoices.tenantId, user.tenantId));

  const planRow = await db.query.plans.findFirst({ where: (p, { eq: e }) => e(p.id, sub.planId) });
  const base = Number(planRow?.monthlyPrice ?? 0);
  const lineItems = [
    { description: `${planRow?.name ?? "Subscription"} plan — ${sub.currentPeriodStart} to ${sub.currentPeriodEnd}`, amount: base },
    { description: `AI usage this period (${Number(aiTokens).toLocaleString()} tokens, included)`, amount: 0 },
  ];
  const total = lineItems.reduce((a, li) => a + li.amount, 0);

  const [invoice] = await db
    .insert(invoices)
    .values({
      tenantId: user.tenantId,
      subscriptionId: sub.id,
      number: `INV-${new Date().getFullYear()}-${String(Number(count) + 1).padStart(4, "0")}`,
      status: "issued",
      lineItems,
      subtotal: total.toFixed(2),
      total: total.toFixed(2),
      issuedAt: new Date(),
      dueAt: new Date(Date.now() + 14 * 86400_000),
    })
    .returning();
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    action: "invoice.generate",
    entityType: "invoice",
    entityId: invoice.id,
  });
  revalidatePath("/billing");
  return { ok: true };
}

export async function submitFeatureRequest(formData: FormData) {
  const user = await requireUser();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (title.length < 4) return { error: "Title required" };
  await db.insert(featureRequests).values({
    tenantId: user.tenantId,
    clientId: user.clientId,
    title,
    description,
    submittedBy: user.id,
  });
  revalidatePath("/features");
  return { ok: true };
}

export async function voteFeatureRequest(featureRequestId: string) {
  const user = await requireUser();
  const [existing] = await db
    .select()
    .from(votes)
    .where(and(eq(votes.featureRequestId, featureRequestId), eq(votes.userId, user.id)));
  if (existing) return { error: "Already voted" };
  await db.insert(votes).values({
    tenantId: user.tenantId,
    featureRequestId,
    userId: user.id,
  });
  await db
    .update(featureRequests)
    .set({ voteCount: dsql`${featureRequests.voteCount} + 1` })
    .where(and(eq(featureRequests.id, featureRequestId), eq(featureRequests.tenantId, user.tenantId)));
  revalidatePath("/features");
  return { ok: true };
}

/** Kick off the onboarding drip for a newly invited portal user. */
export async function startOnboardingDrip(userId: string) {
  const user = await requirePermission("clients:manage");
  for (const day of [0, 2, 5, 10]) {
    await enqueueNotificationJob(
      {
        tenantId: user.tenantId,
        kind: "onboarding_drip",
        input: { userId, dayIndex: day },
      },
      { delay: day * 86400_000 }
    );
  }
  return { ok: true };
}
