import type { Job } from "@/modules/jobs/types";
import { sendInstalmentReminders } from "./instalments";

/**
 * Background jobs of the finance module. Registered in modules/jobs/registry.ts.
 *
 * `instalment-reminders` (every 30 minutes): the WhatsApp reminder before each
 * instalment of an active plan (within the plan's reminder days) and the one
 * the day after it when still owed, each claimed on the instalment before it
 * goes so it goes once; the desk and the owner are told what became overdue.
 * Nothing in the clinic's quiet hours.
 */
export const jobs: Job[] = [
  {
    name: "instalment-reminders",
    everyMinutes: 30,
    async run({ now }) {
      const s = await sendInstalmentReminders(now);
      if (s.reminded || s.overdue || s.failed) return `${s.reminded} reminded, ${s.overdue} overdue, ${s.failed} failed`;
    },
  },
];
