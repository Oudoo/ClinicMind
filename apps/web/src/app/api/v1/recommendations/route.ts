import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, recommendations } from "@growengine/db";
import { authenticateApiKey } from "@/lib/api-auth";

/** Public Grow Engine API — GET /api/v1/recommendations?clientId= */
export async function GET(request: NextRequest) {
  const authResult = await authenticateApiKey(request);
  if (!authResult) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }
  const clientId = request.nextUrl.searchParams.get("clientId");
  const conditions = [eq(recommendations.tenantId, authResult.tenantId)];
  if (clientId) conditions.push(eq(recommendations.clientId, clientId));

  const rows = await db
    .select()
    .from(recommendations)
    .where(and(...conditions))
    .limit(500);

  return NextResponse.json({
    count: rows.length,
    data: rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      title: r.title,
      body: r.body,
      category: r.category,
      status: r.status,
      confidenceScore: r.confidenceScore ? Number(r.confidenceScore) : null,
      evidenceCount: r.evidenceCount,
      dataSources: r.dataSources,
      evidence: r.evidence,
      createdAt: r.createdAt,
    })),
  });
}
