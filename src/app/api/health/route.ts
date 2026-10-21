import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Liveness + readiness probe (DB connectivity). */
export async function GET() {
  let database = "down";
  try {
    await db.$queryRaw`SELECT 1`;
    database = "up";
  } catch {
    database = "down";
  }
  const healthy = database === "up";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", database, service: "clinicmind", ts: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
