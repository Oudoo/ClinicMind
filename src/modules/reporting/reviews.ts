import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { readTenantSetting } from "@/lib/tenant-settings";
import { dateKeyInTz, startOfWeekInTz } from "@/lib/time";
import { zDate } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";

/**
 * Public review snapshots: one row per week with the review count and the
 * rating, entered by hand or pulled from Google Business Profile when the
 * tenant has a place id and the server a Places API key.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export const ReviewSnapshotInput = z.object({
  weekStart: zDate,
  count: z.number().int().min(0).max(1_000_000),
  rating: z.number().min(0).max(5),
});
export type ReviewSnapshotInput = z.infer<typeof ReviewSnapshotInput>;

/** The calendar date (UTC midnight) of the clinic week containing `date`. */
export function weekStartDate(date: Date, timeZone: string): Date {
  const key = dateKeyInTz(startOfWeekInTz(date, timeZone), timeZone);
  return new Date(`${key}T00:00:00.000Z`);
}

export async function listReviewSnapshots(tenantId: string, take = 26) {
  return db.reviewSnapshot.findMany({ where: { tenantId }, orderBy: { weekStart: "desc" }, take });
}

/** Manual entry (owner): one snapshot per week, replaced when entered again. */
export async function recordReviewSnapshot(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = ReviewSnapshotInput.parse(rawInput);
  const timeZone = await getTenantTimezone(tenantId);
  // zDate yields UTC midnight of the given date; read it as that calendar date on the clinic clock.
  const weekStart = weekStartDate(new Date(input.weekStart.getTime() + 12 * 3_600_000), timeZone);
  const row = await db.reviewSnapshot.upsert({
    where: { tenantId_source_weekStart: { tenantId, source: "MANUAL", weekStart } },
    create: { tenantId, source: "MANUAL", weekStart, count: input.count, rating: input.rating, createdById: actor.id ?? null },
    update: { count: input.count, rating: input.rating, createdById: actor.id ?? null },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "review_snapshot.record",
    entity: "ReviewSnapshot",
    entityId: row.id,
    after: { weekStart: row.weekStart.toISOString().slice(0, 10), count: row.count, rating: row.rating },
  });
  return row;
}

interface ReviewsSetting {
  placeId?: string;
}

export type PullResult = "not_configured" | "exists" | "pulled" | "failed";

/**
 * Weekly Google Business Profile pull: Places API details (rating,
 * user_ratings_total) when GOOGLE_PLACES_API_KEY and the tenant's
 * `reviews.placeId` setting are set; otherwise nothing happens.
 */
export async function pullGoogleReviews(tenantId: string, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<PullResult> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  const setting = await readTenantSetting<ReviewsSetting>(tenantId, "reviews", {});
  const placeId = setting.placeId?.trim();
  if (!key || !placeId) return "not_configured";
  const timeZone = await getTenantTimezone(tenantId);
  const weekStart = weekStartDate(now, timeZone);
  const existing = await db.reviewSnapshot.findUnique({ where: { tenantId_source_weekStart: { tenantId, source: "GOOGLE_BUSINESS_PROFILE", weekStart } }, select: { id: true } });
  if (existing) return "exists";
  try {
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=rating,user_ratings_total&key=${encodeURIComponent(key)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Places API responded ${res.status}`);
    const body = (await res.json()) as { status?: string; result?: { rating?: number; user_ratings_total?: number } };
    if (body.status !== "OK" || !body.result) throw new Error(`Places API status ${body.status ?? "unknown"}`);
    const count = Math.max(0, Math.round(body.result.user_ratings_total ?? 0));
    const rating = Math.min(5, Math.max(0, Number(body.result.rating ?? 0)));
    await db.reviewSnapshot.create({ data: { tenantId, source: "GOOGLE_BUSINESS_PROFILE", weekStart, count, rating } });
    return "pulled";
  } catch (err) {
    console.error(`[reporting] Google reviews pull failed for tenant ${tenantId}`, err);
    return "failed";
  }
}
