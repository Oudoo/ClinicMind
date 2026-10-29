import type { Job } from "./types";
import { jobs as aiLogJobs } from "@/modules/ai-log/jobs";
import { jobs as appointmentJobs } from "@/modules/appointments/jobs";
import { jobs as conciergeJobs } from "@/modules/concierge/jobs";
import { jobs as crmJobs } from "@/modules/crm/jobs";
import { jobs as financeJobs } from "@/modules/finance/jobs";
import { jobs as labJobs } from "@/modules/lab/jobs";
import { jobs as notificationJobs } from "@/modules/notifications/jobs";
import { jobs as recallJobs } from "@/modules/recalls/jobs";
import { jobs as reportingJobs } from "@/modules/reporting/jobs";

/** Every background job the server knows, in the order they run. */
export const JOBS: readonly Job[] = [...appointmentJobs, ...conciergeJobs, ...crmJobs, ...financeJobs, ...labJobs, ...notificationJobs, ...recallJobs, ...reportingJobs, ...aiLogJobs];

export function findJob(name: string): Job | undefined {
  return JOBS.find((j) => j.name === name);
}
