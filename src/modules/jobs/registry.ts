import type { Job } from "./types";
import { jobs as appointmentJobs } from "@/modules/appointments/jobs";
import { jobs as conciergeJobs } from "@/modules/concierge/jobs";
import { jobs as crmJobs } from "@/modules/crm/jobs";
import { jobs as notificationJobs } from "@/modules/notifications/jobs";
import { jobs as reportingJobs } from "@/modules/reporting/jobs";

/** Every background job the server knows, in the order they run. */
export const JOBS: readonly Job[] = [...appointmentJobs, ...conciergeJobs, ...crmJobs, ...notificationJobs, ...reportingJobs];

export function findJob(name: string): Job | undefined {
  return JOBS.find((j) => j.name === name);
}
