import type { Job } from "@/modules/jobs/types";
import { notifyLateLabOrders } from "./orders";

/**
 * Background jobs of lab work. Registered in modules/jobs/registry.ts.
 *
 * `lab-orders-late` (every hour): the doctor who asked and the desk are told,
 * once, of each lab order still at the lab past its day.
 */
export const jobs: Job[] = [
  {
    name: "lab-orders-late",
    everyMinutes: 60,
    async run({ now }) {
      const s = await notifyLateLabOrders(now);
      if (s.late) return `${s.late} lab order${s.late === 1 ? "" : "s"} late`;
    },
  },
];
