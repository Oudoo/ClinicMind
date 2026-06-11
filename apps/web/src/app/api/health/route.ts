import { NextResponse } from "next/server";
import { getSystemHealth } from "@growengine/core";
import { auth } from "@/lib/auth";

/** System health snapshot for the ops dashboard (auto-refreshes). */
export async function GET() {
  const session = await auth();
  if (!session?.user?.tenantId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const health = await getSystemHealth();
  return NextResponse.json(health);
}
