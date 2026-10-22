import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { usingDevSecrets } from "@/lib/env";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

/**
 * Liveness + readiness probe. 200 when the database answers, 503 otherwise.
 * Reports only operational facts — never configuration values.
 */
export async function GET() {
  const t0 = Date.now();
  let database: "up" | "down" = "down";
  try {
    await db.$queryRaw`SELECT 1`;
    database = "up";
  } catch {
    database = "down";
  }
  const dbLatencyMs = Date.now() - t0;
  const healthy = database === "up";
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "clinicmind",
      version: pkg.version,
      database,
      dbLatencyMs,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      devSecrets: usingDevSecrets,
      ts: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
