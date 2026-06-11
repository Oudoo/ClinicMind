"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  db,
  tenants,
  users,
  roles,
  permissions,
  rolePermissions,
  userRoles,
  plans,
  subscriptions,
  dataRetentionPolicies,
  tenantInvites,
} from "@growengine/db";
import { audit, publishEvent, EVENT_TYPES } from "@growengine/core";
import { slugify } from "@/lib/utils";

const PERMISSION_KEYS = [
  "clients:read", "clients:manage",
  "integrations:read", "integrations:manage",
  "meetings:read", "meetings:manage",
  "intelligence:read", "intelligence:manage",
  "creative:read", "creative:manage",
  "work:read", "work:manage",
  "aom:read", "aom:manage",
  "billing:read", "billing:admin",
  "settings:admin", "system:admin",
];

const DEFAULT_ROLES: Record<string, string[]> = {
  Admin: PERMISSION_KEYS,
  "Account Manager": [
    "clients:read", "clients:manage", "integrations:read", "meetings:read", "meetings:manage",
    "intelligence:read", "intelligence:manage", "creative:read", "creative:manage",
    "work:read", "work:manage", "aom:read", "aom:manage",
  ],
  Analyst: ["clients:read", "integrations:read", "intelligence:read", "aom:read", "work:read"],
  "Client User": [],
};

const registerSchema = z.object({
  organizationName: z.string().min(2).max(80),
  name: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(10).max(128),
});

/** Tenant self-service signup — creates the workspace, roles and admin. */
export async function registerTenant(formData: FormData) {
  const parsed = registerSchema.safeParse({
    organizationName: formData.get("organizationName"),
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;
  const slug = slugify(input.organizationName);

  const [existing] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  if (existing) return { error: "A workspace with this name already exists." };

  const [tenant] = await db
    .insert(tenants)
    .values({ name: input.organizationName, slug })
    .returning();

  // Global permission catalogue (idempotent)
  for (const key of PERMISSION_KEYS) {
    await db.insert(permissions).values({ key }).onConflictDoNothing();
  }
  const allPerms = await db.select().from(permissions);
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  let adminRoleId: string | null = null;
  for (const [roleName, permKeys] of Object.entries(DEFAULT_ROLES)) {
    const [role] = await db
      .insert(roles)
      .values({ tenantId: tenant.id, name: roleName, isSystem: true })
      .returning();
    if (roleName === "Admin") adminRoleId = role.id;
    for (const key of permKeys) {
      const pid = permByKey.get(key);
      if (pid) await db.insert(rolePermissions).values({ roleId: role.id, permissionId: pid });
    }
  }

  const [user] = await db
    .insert(users)
    .values({
      tenantId: tenant.id,
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await bcrypt.hash(input.password, 12),
      isSuperAdmin: true,
    })
    .returning();
  if (adminRoleId) {
    await db.insert(userRoles).values({ userId: user.id, roleId: adminRoleId });
  }

  // Default plan + subscription (billing domain; no gateway)
  let [defaultPlan] = await db.select().from(plans).where(eq(plans.key, "growth"));
  if (!defaultPlan) {
    [defaultPlan] = await db
      .insert(plans)
      .values({
        key: "growth",
        name: "Growth",
        description: "Full platform access",
        monthlyPrice: "499",
        limits: { clients: 25, users: 25, aiTokensPerMonth: 10_000_000 },
        features: ["all_modules"],
      })
      .returning();
  }
  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  await db.insert(subscriptions).values({
    tenantId: tenant.id,
    planId: defaultPlan.id,
    status: "trialing",
    currentPeriodStart: periodStart.toISOString().slice(0, 10),
    currentPeriodEnd: periodEnd.toISOString().slice(0, 10),
  });

  // Default data governance
  const defaults: [string, number][] = [
    ["analytics", 730],
    ["transcripts", 365],
    ["recordings", 180],
    ["audit_logs", 730],
    ["notifications", 90],
  ];
  for (const [category, days] of defaults) {
    await db.insert(dataRetentionPolicies).values({
      tenantId: tenant.id,
      dataCategory: category,
      retentionDays: days,
    });
  }

  await audit({
    tenantId: tenant.id,
    actorId: user.id,
    action: "tenant.register",
    entityType: "tenant",
    entityId: tenant.id,
  });
  await publishEvent({
    tenantId: tenant.id,
    eventType: EVENT_TYPES.tenantCreated,
    entityType: "tenant",
    entityId: tenant.id,
    payload: { slug },
  });

  return { ok: true, tenantSlug: slug };
}

/** Accept an invitation token and create the user account. */
export async function acceptInvite(formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!token || name.length < 2 || password.length < 10) {
    return { error: "Name and a password of at least 10 characters are required." };
  }

  const [invite] = await db.select().from(tenantInvites).where(eq(tenantInvites.token, token));
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return { error: "This invitation is invalid or has expired." };
  }

  const [existingUser] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, invite.tenantId), eq(users.email, invite.email)));
  if (existingUser) return { error: "An account with this email already exists." };

  const [user] = await db
    .insert(users)
    .values({
      tenantId: invite.tenantId,
      email: invite.email,
      name,
      passwordHash: await bcrypt.hash(password, 12),
      clientId: invite.clientId,
    })
    .returning();
  if (invite.roleId) {
    await db.insert(userRoles).values({ userId: user.id, roleId: invite.roleId });
  }
  await db
    .update(tenantInvites)
    .set({ acceptedAt: new Date() })
    .where(eq(tenantInvites.id, invite.id));

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, invite.tenantId));
  await audit({
    tenantId: invite.tenantId,
    actorId: user.id,
    action: "user.accept_invite",
    entityType: "user",
    entityId: user.id,
  });
  return { ok: true, tenantSlug: tenant?.slug };
}
