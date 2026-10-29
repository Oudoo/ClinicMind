import { db, notDeleted } from "@/lib/db";
import type { Job } from "@/modules/jobs/types";
import { sendMonthlyReview } from "./review";

/**
 * Background job of the AI log. Registered in modules/jobs/registry.ts.
 *
 * `ai-review-monthly` (hourly): from the first of the month at 09:00 on each
 * clinic's clock, tells its clinician owners that last month's AI review is
 * ready (once a month; see modules/ai-log/review.ts).
 */
export const jobs: Job[] = [
  {
    name: "ai-review-monthly",
    everyMinutes: 60,
    async run(ctx) {
      const counts: Record<string, number> = {};
      const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", ...notDeleted }, select: { id: true } });
      for (const { id } of tenants) {
        try {
          const result = await sendMonthlyReview(id, ctx.now);
          counts[result] = (counts[result] ?? 0) + 1;
        } catch (err) {
          ctx.log(`tenant ${id}: monthly AI review failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "no tenants";
    },
  },
];
