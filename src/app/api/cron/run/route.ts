import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runDueJobs } from "@/modules/jobs/run";
import { JOBS } from "@/modules/jobs/registry";

export const dynamic = "force-dynamic";

/**
 * `POST /api/cron/run[?job=name]` — run every due job (or one job, forced) on
 * behalf of an external scheduler. Requires `Authorization: Bearer CRON_SECRET`;
 * with no secret configured the endpoint is disabled.
 */
export async function POST(req: Request) {
  if (!env.CRON_SECRET) return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const job = new URL(req.url).searchParams.get("job");
  if (job && !JOBS.some((j) => j.name === job)) return NextResponse.json({ error: "unknown_job", jobs: JOBS.map((j) => j.name) }, { status: 404 });
  const results = await runDueJobs(new Date(), { force: true, only: job ? [job] : undefined });
  return NextResponse.json({ ranAt: new Date().toISOString(), results });
}

/** `GET` lists the jobs (same authentication). */
export async function GET(req: Request) {
  if (!env.CRON_SECRET) return NextResponse.json({ error: "cron_disabled" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${env.CRON_SECRET}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ jobs: JOBS.map((j) => ({ name: j.name, everyMinutes: j.everyMinutes })) });
}
