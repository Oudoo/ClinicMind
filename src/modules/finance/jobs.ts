import type { Job } from "@/modules/jobs/types";
import { makeRecurringBills } from "./expenses";
import { sendInstalmentReminders } from "./instalments";

/**
 * Background jobs of the finance module. Registered in modules/jobs/registry.ts.
 *
 * `instalment-reminders` (every 30 minutes): the WhatsApp reminder before each
 * instalment of an active plan (within the plan's reminder days) and the one
 * the day after it when still owed, each claimed on the instalment before it
 * goes so it goes once; the desk and the owner are told what became overdue.
 * Nothing in the clinic's quiet hours.
 *
 * `recurring-expenses` (every hour): the bills of the recurring expenses (the
 * rent, the internet, a service contract) whose day has come, one for each
 * month, at the amount they have then.
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
  {
    name: "recurring-expenses",
    everyMinutes: 60,
    async run({ now }) {
      const s = await makeRecurringBills(null, now);
      if (s.made) return `${s.made} recurring bill${s.made === 1 ? "" : "s"} made`;
    },
  },
];
