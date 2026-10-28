import type { Prisma, TenantStatus, UserRole, UserStatus } from "@prisma/client";
import { aiConfigOf, invalidateTenantAi, mergeAiConfig, publicAiConfig, type TenantAiPublic } from "@/lib/ai/tenant-config";
import { notDeleted, systemDb } from "@/lib/db";
import { audit } from "@/lib/audit";
import { generateEmbedSecret } from "@/lib/embed";
import { inviteUser } from "@/lib/auth/auth-tokens";
import { normalizeEmail } from "@/lib/auth/request";
import type { TenantBranding } from "@/lib/brand";
import { RESERVED_SLUGS, type BrandingPatch, type OwnerInviteRequest, type ProvisionRequest, type TenantPatch } from "./dto";

/**
 * Platform (system-owner) operations over tenants. A tenant is one client:
 * one clinic group with its own users, data, branding, domain and embed
 * credentials. Platform administrators are SUPER_ADMIN users who live in the
 * dedicated platform tenant; every function here is reachable only through
 * routes that check `platform:manage`.
 */

/** The tenant that holds platform administrators. Never listed as a client. */
export const PLATFORM_TENANT_SLUG = "platform";

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PlatformError";
  }
}

export interface PlatformActor {
  userId: string | null;
  email: string | null;
  ip?: string | null;
}

export interface TenantOwnerSummary {
  id: string;
  email: string;
  fullName: string | null;
  status: UserStatus;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  customDomain: string | null;
  customDomainVerified: boolean;
  branding: TenantBranding;
  createdAt: string | null;
  owner: TenantOwnerSummary | null;
  counts: { users: number; patients: number };
  embed: { enabled: boolean; allowedOrigins: string[]; secretPrefix: string | null; secretRotatedAt: string | null } | null;
}

export interface TenantUserSummary extends TenantOwnerSummary {
  role: UserRole;
  createdAt: string | null;
}

/** ISO string for a Date (or date-like value); null when absent. */
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export interface TenantDetail extends TenantSummary {
  clinics: { id: string; name: string; timezone: string; address: string | null; phone: string | null }[];
  users: TenantUserSummary[];
  counts: { users: number; patients: number; appointments: number; consultations: number; visits: number };
  /** The tenant's AI providers and models; keys are shown as set/unset with a four-character hint. */
  ai: TenantAiPublic;
}

const embedSelect = { enabled: true, allowedOrigins: true, secretPrefix: true, secretRotatedAt: true } as const;

const summarySelect = {
  id: true,
  slug: true,
  name: true,
  status: true,
  customDomain: true,
  customDomainVerified: true,
  branding: true,
  createdAt: true,
  embed: { select: embedSelect },
  _count: { select: { users: true, patients: true } },
} as const;

const userSelect = { id: true, email: true, fullName: true, role: true, status: true, createdAt: true } as const;

type SummaryRow = Prisma.TenantGetPayload<{ select: typeof summarySelect }>;

/** Branding as stored, as a typed object (unknown JSON tolerated). */
export function brandingOf(value: unknown): TenantBranding {
  if (!value || typeof value !== "object") return {};
  const b = value as Record<string, unknown>;
  const out: TenantBranding = {};
  if (typeof b.productName === "string" && b.productName) out.productName = b.productName;
  if (typeof b.accent === "string" && b.accent) out.accent = b.accent;
  if (typeof b.logoUrl === "string" && b.logoUrl) out.logoUrl = b.logoUrl;
  return out;
}

/** Apply a PATCH to stored branding: named keys override, empty strings clear. */
export function mergeBranding(current: unknown, patch: BrandingPatch | undefined): TenantBranding {
  const next = brandingOf(current);
  if (!patch) return next;
  for (const key of ["productName", "accent", "logoUrl"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === "") delete next[key];
    else next[key] = key === "accent" ? value.toUpperCase() : value;
  }
  return next;
}

function toSummary(row: SummaryRow, owner: TenantOwnerSummary | null): TenantSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    customDomain: row.customDomain ?? null,
    customDomainVerified: Boolean(row.customDomainVerified),
    branding: brandingOf(row.branding),
    createdAt: iso(row.createdAt),
    owner,
    counts: { users: row._count?.users ?? 0, patients: row._count?.patients ?? 0 },
    embed: row.embed
      ? {
          enabled: Boolean(row.embed.enabled),
          allowedOrigins: row.embed.allowedOrigins ?? [],
          secretPrefix: row.embed.secretPrefix ?? null,
          secretRotatedAt: iso(row.embed.secretRotatedAt),
        }
      : null,
  };
}

async function ownersFor(tenantIds: string[]): Promise<Map<string, TenantOwnerSummary>> {
  const map = new Map<string, TenantOwnerSummary>();
  if (!tenantIds.length) return map;
  const owners = await systemDb.user.findMany({
    where: { tenantId: { in: tenantIds }, role: "CLINIC_OWNER", deletedAt: null },
    select: { tenantId: true, id: true, email: true, fullName: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  for (const o of owners) {
    if (!map.has(o.tenantId)) map.set(o.tenantId, { id: o.id, email: o.email, fullName: o.fullName, status: o.status });
  }
  return map;
}

/** Every client tenant, newest first. The platform tenant itself is excluded. */
export async function listTenants(): Promise<TenantSummary[]> {
  const rows = (
    await systemDb.tenant.findMany({ where: { ...notDeleted }, select: summarySelect, orderBy: { createdAt: "desc" } })
  ).filter((t) => t.slug !== PLATFORM_TENANT_SLUG);
  const owners = await ownersFor(rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, owners.get(r.id) ?? null));
}

/** One client tenant with its clinics, users and usage counts; null when unknown. */
export async function getTenantDetail(id: string): Promise<TenantDetail | null> {
  const row = await systemDb.tenant.findFirst({
    where: { id, ...notDeleted },
    select: {
      ...summarySelect,
      clinics: {
        where: { deletedAt: null },
        select: { id: true, name: true, timezone: true, address: true, phone: true },
        orderBy: { createdAt: "asc" },
      },
      users: { where: { deletedAt: null }, select: userSelect, orderBy: { createdAt: "asc" } },
      settings: true,
      _count: { select: { users: true, patients: true, appointments: true, consultations: true, visits: true } },
    },
  });
  if (!row || row.slug === PLATFORM_TENANT_SLUG) return null;
  const owner = row.users.find((u) => u.role === "CLINIC_OWNER") ?? null;
  const summary = toSummary(
    { ...row, _count: { users: row._count.users, patients: row._count.patients } },
    owner ? { id: owner.id, email: owner.email, fullName: owner.fullName, status: owner.status } : null,
  );
  return {
    ...summary,
    clinics: row.clinics,
    users: row.users.map((u) => ({ ...u, createdAt: iso(u.createdAt) })),
    counts: {
      users: row._count.users,
      patients: row._count.patients,
      appointments: row._count.appointments,
      consultations: row._count.consultations,
      visits: row._count.visits,
    },
    ai: publicAiConfig(aiConfigOf(row.settings)),
  };
}

export interface ProvisionResult {
  tenant: { id: string; slug: string; name: string };
  owner: { id: string; email: string };
  inviteUrl: string;
  inviteExpiresAt: string;
  /** Shown once; stored only as a hash. */
  embedSecret: string;
}

/**
 * Create a client: the tenant, its embed configuration (fresh secret), a
 * default clinic and the invited owner, in one transaction. The owner's
 * invitation is e-mailed and returned; the embed secret is returned once.
 */
export async function provisionTenant(input: ProvisionRequest, actor: PlatformActor): Promise<ProvisionResult> {
  if (RESERVED_SLUGS.has(input.slug)) throw new PlatformError("slug_reserved", 422, "That slug is reserved.");
  const existing = await systemDb.tenant.findFirst({ where: { slug: input.slug }, select: { id: true } });
  if (existing) throw new PlatformError("slug_taken", 409, "A tenant with that slug already exists.");
  if (input.customDomain) {
    const domainTaken = await systemDb.tenant.findFirst({ where: { customDomain: input.customDomain }, select: { id: true } });
    if (domainTaken) throw new PlatformError("domain_taken", 409, "That domain is already assigned to another tenant.");
  }

  const embedSecret = generateEmbedSecret();
  const branding = mergeBranding(null, input.branding);

  const { tenant, owner } = await systemDb.$transaction(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        slug: input.slug,
        name: input.name,
        status: "ACTIVE",
        branding: branding as Prisma.InputJsonObject,
        customDomain: input.customDomain,
        embed: {
          create: {
            enabled: true,
            allowedOrigins: input.allowedOrigins ?? [],
            secretHash: embedSecret.hash,
            secretPrefix: embedSecret.prefix,
            secretRotatedAt: new Date(),
          },
        },
        clinics: { create: { name: input.name, timezone: input.timezone ?? "Africa/Cairo" } },
      },
      select: { id: true, slug: true, name: true },
    });
    const u = await tx.user.create({
      data: {
        tenantId: t.id,
        email: normalizeEmail(input.ownerEmail),
        fullName: input.ownerFullName || null,
        role: "CLINIC_OWNER",
        status: "INVITED",
        isClinician: true,
      },
      select: { id: true, email: true, fullName: true },
    });
    return { tenant: t, owner: u };
  });

  const invite = await inviteUser({ ...owner, tenantName: tenant.name });

  await audit({
    tenantId: tenant.id,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    action: "tenant.provision",
    entity: "Tenant",
    entityId: tenant.id,
    after: { slug: tenant.slug, name: tenant.name, embedSecretPrefix: embedSecret.prefix, ownerId: owner.id, branding },
  });

  return {
    tenant,
    owner: { id: owner.id, email: owner.email },
    inviteUrl: invite.url,
    inviteExpiresAt: invite.expiresAt.toISOString(),
    embedSecret: embedSecret.secret,
  };
}

/** Update a client's name, status, branding, domain or embed settings. */
export async function updateTenant(id: string, patch: TenantPatch, actor: PlatformActor): Promise<TenantDetail> {
  const current = await systemDb.tenant.findFirst({
    where: { id, ...notDeleted },
    select: { id: true, slug: true, name: true, status: true, branding: true, settings: true, customDomain: true, customDomainVerified: true, embed: { select: embedSelect } },
  });
  if (!current || current.slug === PLATFORM_TENANT_SLUG) throw new PlatformError("not_found", 404);
  if (patch.customDomain) {
    const clash = await systemDb.tenant.findFirst({ where: { customDomain: patch.customDomain, id: { not: id } }, select: { id: true } });
    if (clash) throw new PlatformError("domain_taken", 409, "That domain is already assigned to another tenant.");
  }

  const data: Prisma.TenantUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  if (patch.name !== undefined && patch.name !== current.name) {
    data.name = patch.name;
    before.name = current.name;
    after.name = patch.name;
  }
  if (patch.status !== undefined && patch.status !== current.status) {
    data.status = patch.status;
    before.status = current.status;
    after.status = patch.status;
  }
  if (patch.branding !== undefined) {
    const merged = mergeBranding(current.branding, patch.branding);
    data.branding = merged as Prisma.InputJsonObject;
    before.branding = brandingOf(current.branding);
    after.branding = merged;
  }
  if (patch.customDomain !== undefined && patch.customDomain !== current.customDomain) {
    data.customDomain = patch.customDomain;
    // A new or removed domain is unverified until the platform confirms DNS.
    data.customDomainVerified = patch.customDomain ? (patch.customDomainVerified ?? false) : false;
    before.customDomain = current.customDomain;
    after.customDomain = patch.customDomain;
  } else if (patch.customDomainVerified !== undefined && patch.customDomainVerified !== current.customDomainVerified) {
    data.customDomainVerified = current.customDomain ? patch.customDomainVerified : false;
    before.customDomainVerified = current.customDomainVerified;
    after.customDomainVerified = data.customDomainVerified;
  }

  if (patch.ai !== undefined) {
    const currentAi = aiConfigOf(current.settings);
    const merged = mergeAiConfig(currentAi, patch.ai);
    const settings = current.settings && typeof current.settings === "object" && !Array.isArray(current.settings) ? (current.settings as Record<string, unknown>) : {};
    data.settings = { ...settings, ai: merged } as unknown as Prisma.InputJsonObject;
    // Audit the public shape only: providers, models and whether a key is set, never a key.
    before.ai = publicAiConfig(currentAi);
    after.ai = publicAiConfig(merged);
    invalidateTenantAi(id);
  }

  const embedData: Prisma.TenantEmbedConfigUpdateInput = {};
  if (patch.allowedOrigins !== undefined) {
    embedData.allowedOrigins = patch.allowedOrigins;
    before.allowedOrigins = current.embed?.allowedOrigins ?? [];
    after.allowedOrigins = patch.allowedOrigins;
  }
  if (patch.embedEnabled !== undefined) {
    embedData.enabled = patch.embedEnabled;
    before.embedEnabled = current.embed?.enabled ?? false;
    after.embedEnabled = patch.embedEnabled;
  }
  if (Object.keys(embedData).length) {
    data.embed = current.embed
      ? { update: embedData }
      : { create: { enabled: patch.embedEnabled ?? false, allowedOrigins: patch.allowedOrigins ?? [] } };
  }

  if (Object.keys(data).length) {
    await systemDb.tenant.update({ where: { id }, data });
    await audit({
      tenantId: id,
      actorId: actor.userId,
      actorEmail: actor.email,
      ip: actor.ip ?? null,
      action: after.status !== undefined ? "tenant.status" : "tenant.update",
      entity: "Tenant",
      entityId: id,
      before,
      after,
    });
  }

  const detail = await getTenantDetail(id);
  if (!detail) throw new PlatformError("not_found", 404);
  return detail;
}

export interface OwnerInviteResult {
  owner: TenantOwnerSummary;
  inviteUrl: string;
  inviteExpiresAt: string;
}

/**
 * Invite a clinic owner for a tenant: creates the CLINIC_OWNER user when the
 * e-mail is new, re-issues the invitation when that owner has not set a
 * password yet, and refuses when the account is already active.
 */
export async function inviteOwner(id: string, input: OwnerInviteRequest, actor: PlatformActor): Promise<OwnerInviteResult> {
  const tenant = await systemDb.tenant.findFirst({ where: { id, ...notDeleted }, select: { id: true, slug: true, name: true } });
  if (!tenant || tenant.slug === PLATFORM_TENANT_SLUG) throw new PlatformError("not_found", 404);

  const email = normalizeEmail(input.email);
  const existing = await systemDb.user.findFirst({
    where: { tenantId: tenant.id, email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true, email: true, fullName: true, role: true, status: true, passwordHash: true },
  });

  let owner: TenantOwnerSummary;
  let action: string;
  if (existing) {
    if (existing.status !== "INVITED" && existing.passwordHash) {
      throw new PlatformError("email_taken", 409, "That person already has an active account in this tenant.");
    }
    const updated = await systemDb.user.update({
      where: { id: existing.id },
      data: { role: "CLINIC_OWNER", fullName: input.fullName || existing.fullName },
      select: { id: true, email: true, fullName: true, status: true },
    });
    owner = updated;
    action = "tenant.owner.reinvite";
  } else {
    owner = await systemDb.user.create({
      data: { tenantId: tenant.id, email, fullName: input.fullName || null, role: "CLINIC_OWNER", status: "INVITED", isClinician: true },
      select: { id: true, email: true, fullName: true, status: true },
    });
    action = "tenant.owner.invite";
  }

  const invite = await inviteUser({ id: owner.id, email: owner.email, fullName: owner.fullName, tenantName: tenant.name });
  await audit({
    tenantId: tenant.id,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    action,
    entity: "User",
    entityId: owner.id,
    after: { email: owner.email },
  });

  return { owner, inviteUrl: invite.url, inviteExpiresAt: invite.expiresAt.toISOString() };
}

/** A clinic owner updates the branding of their own tenant. */
export async function updateOwnBranding(tenantId: string, patch: BrandingPatch, actor: PlatformActor): Promise<TenantBranding> {
  const current = await systemDb.tenant.findFirst({ where: { id: tenantId, ...notDeleted }, select: { branding: true } });
  if (!current) throw new PlatformError("not_found", 404);
  const merged = mergeBranding(current.branding, patch);
  await systemDb.tenant.update({ where: { id: tenantId }, data: { branding: merged as Prisma.InputJsonObject } });
  await audit({
    tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    action: "tenant.branding",
    entity: "Tenant",
    entityId: tenantId,
    before: brandingOf(current.branding),
    after: merged,
  });
  return merged;
}
