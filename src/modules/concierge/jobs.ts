import type { Job } from "@/modules/jobs/types";
import { runAckOverdue, runConciergeDispatch } from "./dispatch";

/**
 * Background jobs of the concierge module. Registered in modules/jobs/registry.ts;
 * each job is idempotent and safe to run every minute.
 *
 *  - `concierge-dispatch` (every minute): due steps go out, 24-hour reminders,
 *    48-hour misses (a missed high-risk check-in opens a watch escalation),
 *    finished enrolments complete. See dispatch.ts.
 *  - `concierge-ack-overdue` (every 5 minutes): open escalations past their
 *    acknowledgement target are told again to the assignee, the backup and
 *    the owner.
 *
 * Every write inside is claimed with a conditional update, so overlapping runs
 * (two server processes, the cron endpoint) never send twice; within one
 * process a run that is still going is not started again.
 */
export const DISPATCH_JOB = "concierge-dispatch";
export const ACK_OVERDUE_JOB = "concierge-ack-overdue";

const running = new Set<string>();

async function once(name: string, fn: () => Promise<string>): Promise<string> {
  if (running.has(name)) return "previous run still in progress";
  running.add(name);
  try {
    return await fn();
  } finally {
    running.delete(name);
  }
}

export const jobs: Job[] = [
  {
    name: DISPATCH_JOB,
    everyMinutes: 1,
    run: ({ now }) => once(DISPATCH_JOB, () => runConciergeDispatch(now)),
  },
  {
    name: ACK_OVERDUE_JOB,
    everyMinutes: 5,
    run: ({ now }) => once(ACK_OVERDUE_JOB, () => runAckOverdue(now)),
  },
];
