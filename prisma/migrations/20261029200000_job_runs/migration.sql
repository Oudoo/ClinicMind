-- When each background job last ran, for every server process at once
-- (src/modules/jobs/run.ts): a process claims a job's run here before it runs
-- it, so two processes never run the same job twice in one interval.
CREATE TABLE "job_runs" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("name")
);

-- Not a clinic's data: the jobs run on the owner connection, as do the
-- sessions and tokens (see the application_role migration).
REVOKE ALL ON "job_runs" FROM clinicmind_app;
