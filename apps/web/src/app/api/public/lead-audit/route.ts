import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, leadAudits, tenants } from "@growengine/db";
import { publishEvent, EVENT_TYPES, redis } from "@growengine/core";
import { createAiJob } from "@/lib/jobs";

/**
 * Interactive Business Audit Lead Magnet — public endpoint consumed by the
 * embeddable widget (/audit). Rate-limited per IP; the audit itself runs
 * in the AI worker (live crawl + analysis), never in this request.
 */

const submissionSchema = z.object({
  tenantSlug: z.string().min(1),
  companyName: z.string().min(2).max(160),
  contactName: z.string().min(2).max(120),
  contactEmail: z.string().email(),
  websiteUrl: z.string().url(),
  industry: z.string().max(80).optional(),
  monthlyAdBudget: z.string().max(40).optional(),
  primaryGoal: z.string().max(200).optional(),
  responses: z.record(z.string(), z.string()).optional(),
  utmSource: z.string().max(120).optional(),
});

export async function POST(request: NextRequest) {
  // Per-IP rate limit: 5 submissions/hour
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rlKey = `lead_audit:rl:${ip}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, 3600);
  if (count > 5) {
    return NextResponse.json({ error: "Too many submissions; try again later." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const parsed = submissionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid submission" },
      { status: 400 }
    );
  }

  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, parsed.data.tenantSlug));
  if (!tenant || tenant.status !== "active") {
    return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
  }

  const [lead] = await db
    .insert(leadAudits)
    .values({
      tenantId: tenant.id,
      companyName: parsed.data.companyName,
      contactName: parsed.data.contactName,
      contactEmail: parsed.data.contactEmail.toLowerCase(),
      websiteUrl: parsed.data.websiteUrl,
      industry: parsed.data.industry,
      monthlyAdBudget: parsed.data.monthlyAdBudget,
      primaryGoal: parsed.data.primaryGoal,
      responses: parsed.data.responses ?? {},
      utmSource: parsed.data.utmSource,
    })
    .returning();

  await publishEvent({
    tenantId: tenant.id,
    eventType: EVENT_TYPES.leadAuditSubmitted,
    entityType: "lead_audit",
    entityId: lead.id,
    payload: { companyName: lead.companyName },
  });
  await createAiJob(tenant.id, null, "lead_audit", { leadAuditId: lead.id });

  return NextResponse.json({ ok: true, auditId: lead.id });
}

/** Poll audit status + report (the widget polls this). */
export async function GET(request: NextRequest) {
  const auditId = request.nextUrl.searchParams.get("id");
  if (!auditId) return NextResponse.json({ error: "id required" }, { status: 400 });
  const [lead] = await db.select().from(leadAudits).where(eq(leadAudits.id, auditId));
  if (!lead) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    status: lead.status,
    score: lead.auditScore ? Number(lead.auditScore) : null,
    report: lead.status === "completed" ? lead.auditReport : null,
    findings: lead.status === "completed" ? lead.auditFindings : [],
  });
}
