import { NextResponse } from "next/server";
import { db, rlsStatus } from "@/lib/db";
import { usingDevSecrets } from "@/lib/env";
import { aiStatus } from "@/lib/ai/provider";
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
  // Whether the clinic isolation policies bind the app's connection (lib/db.ts).
  const rowLevelSecurity = healthy ? await rlsStatus().then((s) => (s.enforced ? "enforced" : "off"), () => "unknown") : "unknown";
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      service: "clinicmind",
      version: pkg.version,
      database,
      dbLatencyMs,
      rowLevelSecurity,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      devSecrets: usingDevSecrets,
      ai: aiStatus(),
      ts: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
