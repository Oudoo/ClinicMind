import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * `Tenant.settings` is one JSON document shared by several modules (locale,
 * channels, ai, modules, concierge, messaging…). Read it as a plain object and
 * update it by top-level key so modules never overwrite each other.
 */
export type TenantSettings = Record<string, unknown>;

type Client = Prisma.TransactionClient;

export function settingsOf(value: unknown): TenantSettings {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TenantSettings) : {};
}

export async function readTenantSettings(tenantId: string, client: Client = db): Promise<TenantSettings> {
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  return settingsOf(tenant?.settings);
}

/** Read one top-level section, typed by the caller. */
export async function readTenantSetting<T>(tenantId: string, key: string, fallback: T, client: Client = db): Promise<T> {
  const settings = await readTenantSettings(tenantId, client);
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}

/**
 * Merge `patch` into the settings at the top level inside one transaction, so
 * two modules saving at the same time keep each other's keys. Returns the
 * settings after the write.
 */
export async function updateTenantSettings(tenantId: string, patch: TenantSettings): Promise<TenantSettings> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ settings: unknown }[]>`SELECT "settings" FROM "tenants" WHERE "id" = ${tenantId} FOR UPDATE`;
    const current = settingsOf(rows[0]?.settings);
    const next = { ...current, ...patch };
    await tx.tenant.update({ where: { id: tenantId }, data: { settings: next as Prisma.InputJsonObject } });
    return next;
  });
}
