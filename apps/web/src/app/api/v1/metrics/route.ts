import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gte, lte } from "drizzle-orm";
import { db, metricRecords, clients } from "@growengine/db";
import { authenticateApiKey } from "@/lib/api-auth";

/**
 * Public Grow Engine API — GET /api/v1/metrics
 * Query: clientId, metric, since, until. Returns verifiable metric facts
 * including source request ids and reference links.
 */
export async function GET(request: NextRequest) {
  const authResult = await authenticateApiKey(request);
  if (!authResult) {
    return NextResponse.json({ error: "Invalid or missing API key" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const clientId = params.get("clientId");
  const metric = params.get("metric");
  const since = params.get("since") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const until = params.get("until") ?? new Date().toISOString().slice(0, 10);

  if (!clientId) return NextResponse.json({ error: "clientId is required" }, { status: 400 });

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, authResult.tenantId)));
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const conditions = [
    eq(metricRecords.tenantId, authResult.tenantId),
    eq(metricRecords.clientId, clientId),
    gte(metricRecords.date, since),
    lte(metricRecords.date, until),
  ];
  if (metric) conditions.push(eq(metricRecords.metric, metric));

  const rows = await db
    .select({
      metric: metricRecords.metric,
      date: metricRecords.date,
      value: metricRecords.value,
      currency: metricRecords.currency,
      dimensions: metricRecords.dimensions,
      provider: metricRecords.provider,
      sourceRequestId: metricRecords.sourceRequestId,
      sourceReferenceUrl: metricRecords.sourceReferenceUrl,
      sanityStatus: metricRecords.sanityStatus,
      fetchedAt: metricRecords.fetchedAt,
    })
    .from(metricRecords)
    .where(and(...conditions))
    .limit(10000);

  return NextResponse.json({
    client: { id: client.id, name: client.name },
    range: { since, until },
    count: rows.length,
    data: rows,
  });
}
