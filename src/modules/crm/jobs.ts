import type { Job } from "@/modules/jobs/types";
import { sweepOverdueFollowUps } from "./service";

/**
 * Background jobs of the crm module. Registered in modules/jobs/registry.ts;
 * each job is idempotent and safe to run every minute.
 *
 * `crm-follow-ups` (every 5 minutes): one FOLLOW_UP_OVERDUE notification per
 * follow-up that passed its time, and one LEAD_FOLLOW_UP escalation per lead
 * once a follow-up is more than 24 hours overdue (see sweepOverdueFollowUps).
 */
export const jobs: Job[] = [
  {
    name: "crm-follow-ups",
    everyMinutes: 5,
    async run(ctx) {
      const result = await sweepOverdueFollowUps(ctx.now);
      return `${result.notified} overdue notified, ${result.escalated} escalated across ${result.tenants} tenants`;
    },
  },
];
