import type { Job } from "@/modules/jobs/types";

/**
 * Background jobs of the crm module. Registered in modules/jobs/registry.ts;
 * each job is idempotent and safe to run every minute.
 */
export const jobs: Job[] = [];
