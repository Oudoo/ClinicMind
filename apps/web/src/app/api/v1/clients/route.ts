import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, clients, healthScores } from "@growengine/db";
import { authenticateApiKey } from "@/lib/api-auth";

/** Public Grow Engine API — GET /api/v1/clients */
export async function GET(request: NextRequest) {
  const authResult = await authenticateApiKey(request);
  if (!authResult) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }

  const rows = await db
    .select()
    .from(clients)
    .where(eq(clients.tenantId, authResult.tenantId));

  const scores = await db
    .select()
    .from(healthScores)
    .where(eq(healthScores.tenantId, authResult.tenantId));
  const latestScore = new Map<string, number>();
  for (const s of scores) latestScore.set(s.clientId, Number(s.score));

  return NextResponse.json({
    count: rows.length,
    data: rows.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      status: c.status,
      industry: c.industry,
      healthScore: latestScore.get(c.id) ?? null,
      createdAt: c.createdAt,
    })),
  });
}
