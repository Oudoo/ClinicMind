import type { AlertMetric, AlertComparator, Prisma, UserRole } from "@prisma/client";
import type { SeedContext } from "./index";
import { makeRandom } from "./util";

/**
 * What the reports read besides the operational tables:
 *
 * - weekly CampaignCost rows for 26 weeks for the campaigns the CRM seed
 *   created (read from the database; none → logged and skipped), at the spend
 *   the clinic runs: Meta hair transplant ~4,600 EGP a week, acne 1,500, laser
 *   1,900, always-on 900, Google brand 800, melasma 1,100 (±15% a week);
 * - 26 weekly public review snapshots (count 310 → 362, rating 4.6–4.8),
 *   entered by hand as the clinic does today; the current week is left for the
 *   owner to enter;
 * - a target (baseline, target, unit, due date) for each of the thirteen metrics;
 * - four alert rules: no-show rate above 10% over 14 days, first response
 *   median above 60 s over 7 days, follow-ups overdue above 5, a campaign with
 *   100 leads and no procedure.
 *
 * Deterministic (makeRandom(61)); createMany throughout.
 */

const DAY = 86_400_000;

/** Weekly spend by what a campaign is for; the first matching rule wins. */
const SPEND_RULES: { test: (c: { name: string; platform: string; treatmentKey: string | null }) => boolean; weekly: number }[] = [
  { test: (c) => c.platform === "GOOGLE" && /brand/i.test(c.name), weekly: 800 },
  { test: (c) => c.treatmentKey === "pigmentation" || /melasma|pigment/i.test(c.name), weekly: 1_100 },
  { test: (c) => c.treatmentKey === "hair-transplant" || /transplant|fue/i.test(c.name), weekly: 4_600 },
  { test: (c) => c.treatmentKey === "acne" || /acne/i.test(c.name), weekly: 1_500 },
  { test: (c) => c.treatmentKey === "laser-hair-removal" || /laser/i.test(c.name), weekly: 1_900 },
  { test: (c) => c.platform === "META" && (!c.treatmentKey || /always|other|general/i.test(c.name)), weekly: 900 },
];

/** The clinic's targets for the thirteen metrics (headline values; counts per 28 days, the default period). */
const TARGETS: { metric: string; baseline: number; target: number; unit: string }[] = [
  { metric: "M1", baseline: 40, target: 60, unit: "leads/28 d" },
  { metric: "M2", baseline: 28, target: 35, unit: "%" },
  { metric: "M3", baseline: 30, target: 38, unit: "%" },
  { metric: "M4", baseline: 190_000, target: 280_000, unit: "EGP/28 d" },
  { metric: "M5", baseline: 250, target: 60, unit: "s" },
  { metric: "M6", baseline: 12, target: 8, unit: "%" },
  { metric: "M7", baseline: 15, target: 10, unit: "leads/28 d" },
  { metric: "M8", baseline: 35, target: 25, unit: "%" },
  { metric: "M9", baseline: 12, target: 20, unit: "leads/28 d" },
  { metric: "M10", baseline: 28, target: 35, unit: "%" },
  { metric: "M11", baseline: 4.3, target: 4.5, unit: "/5" },
  { metric: "M12", baseline: 12, target: 3, unit: "" },
  { metric: "M13", baseline: 30_000, target: 20_000, unit: "EGP" },
];

const RULES: { name: string; metric: AlertMetric; comparator: AlertComparator; threshold: number; windowDays: number; notifyRoles: UserRole[] }[] = [
  { name: "No-show rate above 10%", metric: "NO_SHOW_RATE", comparator: "ABOVE", threshold: 10, windowDays: 14, notifyRoles: ["CLINIC_OWNER", "RECEPTIONIST"] },
  { name: "First response median above 60 s", metric: "FIRST_RESPONSE_P50", comparator: "ABOVE", threshold: 60, windowDays: 7, notifyRoles: ["CLINIC_OWNER"] },
  { name: "More than 5 follow-ups overdue", metric: "FOLLOW_UPS_OVERDUE", comparator: "ABOVE", threshold: 5, windowDays: 1, notifyRoles: ["CLINIC_OWNER", "RECEPTIONIST"] },
  { name: "Campaign with 100 leads and no procedure", metric: "CAMPAIGN_WITHOUT_PROCEDURE", comparator: "ABOVE", threshold: 0, windowDays: 30, notifyRoles: ["CLINIC_OWNER"] },
];

/** UTC midnight of a calendar date (how @db.Date columns are written). */
const calendarDate = (d: { y: number; m: number; d: number }) => new Date(Date.UTC(d.y, d.m - 1, d.d));

export async function seedReporting(ctx: SeedContext): Promise<void> {
  const r = makeRandom(61);
  const { db, tenantId } = ctx;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const now = ctx.today.getTime();

  // ── Campaign costs: 26 weeks of seven-day blocks ending today ──────────
  const campaigns = await db.campaign.findMany({
    where: { tenantId },
    select: { id: true, name: true, platform: true, startedAt: true, endedAt: true, treatment: { select: { key: true } } },
    orderBy: { createdAt: "asc" },
  });
  const costs: Prisma.CampaignCostCreateManyInput[] = [];
  if (!campaigns.length) {
    console.log("     reporting: no campaigns yet (the CRM seed creates them); campaign costs skipped.");
  } else {
    for (const c of campaigns) {
      const info = { name: c.name, platform: c.platform, treatmentKey: c.treatment?.key ?? null };
      const weekly = SPEND_RULES.find((rule) => rule.test(info))?.weekly ?? 1_000;
      for (let week = 25; week >= 0; week--) {
        const startOffset = -(week * 7 + 6);
        const endOffset = -(week * 7);
        const start = calendarDate(ctx.calendarDay(startOffset));
        const end = calendarDate(ctx.calendarDay(endOffset));
        // Only the weeks the campaign ran.
        if (c.startedAt && c.startedAt.getTime() > now + endOffset * DAY) continue;
        if (c.endedAt && c.endedAt.getTime() < now + startOffset * DAY) continue;
        const amount = Math.round((weekly * (0.85 + r.rand() * 0.3)) / 10) * 10;
        costs.push({
          tenantId,
          campaignId: c.id,
          periodStart: start,
          periodEnd: end,
          amount,
          currency: "EGP",
          source: c.platform === "GOOGLE" ? "google" : c.platform === "META" ? "meta" : "manual",
          createdById: owner.id,
          createdAt: new Date(now + endOffset * DAY),
        });
      }
    }
    await db.campaignCost.createMany({ data: costs });
  }

  // ── Review snapshots: the 26 complete weeks before this one (weeks start on Saturday) ──
  const today = ctx.calendarDay(0);
  const back = (today.weekday - 6 + 7) % 7; // days since Saturday
  const thisWeek = -back;
  const reviews: Prisma.ReviewSnapshotCreateManyInput[] = [];
  let rating = 4.66;
  for (let i = 26; i >= 1; i--) {
    const weekStart = calendarDate(ctx.calendarDay(thisWeek - i * 7));
    const progress = (26 - i) / 25;
    const count = Math.round(310 + progress * 52 + (i > 1 && i < 26 ? r.between(-1, 1) : 0));
    rating = Math.min(4.8, Math.max(4.6, rating + (r.rand() - 0.45) * 0.04));
    reviews.push({ tenantId, source: "MANUAL", weekStart, count, rating: Math.round(rating * 100) / 100, createdById: owner.id, createdAt: new Date(weekStart.getTime() + 2 * DAY) });
  }
  // Counts never go down week to week.
  for (let i = 1; i < reviews.length; i++) {
    const prev = reviews[i - 1]!.count as number;
    if ((reviews[i]!.count as number) < prev) reviews[i]!.count = prev;
  }
  reviews[reviews.length - 1]!.count = 362;
  await db.reviewSnapshot.createMany({ data: reviews, skipDuplicates: true });

  // ── Targets for the thirteen metrics, due in 90 days ───────────────────
  const due = ctx.calendarDay(90);
  await db.metricTarget.createMany({
    data: TARGETS.map((t) => ({ tenantId, metric: t.metric, baseline: t.baseline, target: t.target, unit: t.unit, dueAt: calendarDate(due), updatedById: owner.id })),
    skipDuplicates: true,
  });

  // ── Alert rules ────────────────────────────────────────────────────────
  await db.alertRule.createMany({
    data: RULES.map((rule, i) => ({ tenantId, ...rule, enabled: true, createdById: owner.id, createdAt: new Date(now - (30 - i) * DAY) })),
  });

  console.log(`     reporting: ${costs.length} weekly campaign costs for ${campaigns.length} campaigns, ${reviews.length} review snapshots, ${TARGETS.length} metric targets, ${RULES.length} alert rules.`);
}
