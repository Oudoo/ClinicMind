import { db, notDeleted } from "@/lib/db";
import type { Job, JobContext } from "@/modules/jobs/types";
import { evaluateAlertRules } from "./alerts";
import { sendWeeklyBrief } from "./brief";
import { pullGoogleReviews } from "./reviews";

/**
 * Background jobs of the reporting module. Registered in modules/jobs/registry.ts;
 * each job is idempotent, iterates the active tenants and is safe to run every minute.
 */
async function activeTenantIds(): Promise<string[]> {
  const rows = await db.tenant.findMany({ where: { status: "ACTIVE", ...notDeleted }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Evaluate every enabled alert rule; a rule fires at most once per 24 h. */
export async function runAlertRules(ctx: JobContext): Promise<string> {
  let evaluated = 0;
  let fired = 0;
  for (const tenantId of await activeTenantIds()) {
    try {
      const results = await evaluateAlertRules(tenantId, ctx.now);
      evaluated += results.length;
      fired += results.filter((r) => r.notified).length;
    } catch (err) {
      ctx.log(`tenant ${tenantId}: alert evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `${evaluated} rules evaluated, ${fired} fired`;
}

/** Send the weekly brief once per week (Sunday 08:00 clinic time, idempotent). */
export async function runWeeklyBriefs(ctx: JobContext): Promise<string> {
  let sent = 0;
  for (const tenantId of await activeTenantIds()) {
    try {
      if ((await sendWeeklyBrief(tenantId, ctx.now)) === "sent") sent += 1;
    } catch (err) {
      ctx.log(`tenant ${tenantId}: weekly brief failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return `${sent} briefs sent`;
}

/** Pull the Google Business Profile review count and rating once a week where configured. */
export async function runReviewPulls(ctx: JobContext): Promise<string> {
  const counts: Record<string, number> = {};
  for (const tenantId of await activeTenantIds()) {
    const result = await pullGoogleReviews(tenantId, ctx.now);
    counts[result] = (counts[result] ?? 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "no tenants";
}

export const jobs: Job[] = [
  { name: "reporting-alerts", everyMinutes: 60, run: runAlertRules },
  { name: "reporting-brief", everyMinutes: 30, run: runWeeklyBriefs },
  { name: "reporting-reviews", everyMinutes: 60, run: runReviewPulls },
];
