import type { Job } from "@/modules/jobs/types";
import { sweepRecalls } from "./engine";

/**
 * Background jobs of the recalls module. Registered in modules/jobs/registry.ts;
 * each job is idempotent and safe to run every minute.
 *
 * `recalls-sweep` (every 10 minutes): makes the recalls time brings (planned
 * work not booked, a visit missed and not rebooked in 48 hours, a patient
 * not seen for 12 or 18 months, a course's next session the hook missed),
 * wakes snoozed recalls and brings each one in line with the patient's
 * bookings and visits (see modules/recalls/engine.ts).
 */
export const jobs: Job[] = [
  {
    name: "recalls-sweep",
    everyMinutes: 10,
    async run(ctx) {
      const s = await sweepRecalls(ctx.now);
      const made = s.made.sessions + s.made.missed + s.made.unbooked + s.made.lapsed;
      return `${made} made (${s.made.missed} missed, ${s.made.unbooked} unbooked, ${s.made.lapsed} lapsed, ${s.made.sessions} sessions), ${s.synced} patients synced, ${s.woken} woken across ${s.tenants} tenants`;
    },
  },
];
