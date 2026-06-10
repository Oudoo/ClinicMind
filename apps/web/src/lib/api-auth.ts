import { type NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db, apiKeys, usageRecords } from "@growengine/db";
import { sha256 } from "@growengine/core";

/**
 * Public Grow Engine API authentication — bearer API keys, stored hashed,
 * metered into usage_records.
 */
export async function authenticateApiKey(
  request: NextRequest
): Promise<{ tenantId: string; keyId: string } | null> {
  const header = request.headers.get("authorization") ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!raw || !raw.startsWith("ge_")) return null;

  const [key] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, sha256(raw)), isNull(apiKeys.revokedAt)));
  if (!key) return null;
  if (key.expiresAt && key.expiresAt < new Date()) return null;

  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  await db.insert(usageRecords).values({
    tenantId: key.tenantId,
    meter: "api_calls",
    quantity: "1",
    usageDate: new Date().toISOString().slice(0, 10),
    metadata: { keyId: key.id, path: request.nextUrl.pathname },
  });
  return { tenantId: key.tenantId, keyId: key.id };
}
