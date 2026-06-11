import { and, eq } from "drizzle-orm";
import { db, aeoAudits } from "@growengine/db";
import {
  aiCompleteJson,
  crawlSite,
  computeConfidence,
  publishEvent,
  EVENT_TYPES,
  type AiJobData,
  type CrawledPage,
} from "@growengine/core";

/**
 * AEO/GEO Content Auditor — crawls the client site, measures hard signals
 * (JSON-LD, schema types, heading structure, answerability patterns), then
 * uses the LLM to grade citeability for generative AI search.
 */

interface PageSignals {
  url: string;
  hasJsonLd: boolean;
  jsonLdTypes: string[];
  schemaTypes: string[];
  hasMetaDescription: boolean;
  h1Count: number;
  questionHeadings: number;
  wordCount: number;
  shortAnswerBlocks: number;
}

function extractSignals(page: CrawledPage): PageSignals {
  const jsonLdTypes: string[] = [];
  for (const block of page.structuredData) {
    const items = Array.isArray(block) ? block : [block];
    for (const item of items) {
      const t = (item as { "@type"?: string | string[] })["@type"];
      if (typeof t === "string") jsonLdTypes.push(t);
      else if (Array.isArray(t)) jsonLdTypes.push(...t);
    }
  }
  const questionHeadings = page.headings.filter((h) =>
    /^(what|how|why|when|where|who|can|should|is|are|do|does)\b/i.test(h.text)
  ).length;
  // Citeable short-answer blocks: sentences of 15-40 words following headings
  const sentences = page.text.split(/(?<=[.!?])\s+/);
  const shortAnswerBlocks = sentences.filter((s) => {
    const words = s.split(/\s+/).length;
    return words >= 12 && words <= 40 && /\d|%|because|means|is defined/i.test(s);
  }).length;

  return {
    url: page.url,
    hasJsonLd: page.structuredData.length > 0,
    jsonLdTypes,
    schemaTypes: page.schemaTypes,
    hasMetaDescription: !!page.metaDescription,
    h1Count: page.headings.filter((h) => h.level === 1).length,
    questionHeadings,
    wordCount: page.wordCount,
    shortAnswerBlocks,
  };
}

export async function handleAeoAudit(data: AiJobData) {
  const { aeoAuditId } = data.input as { aeoAuditId: string };
  const [auditRow] = await db
    .select()
    .from(aeoAudits)
    .where(and(eq(aeoAudits.id, aeoAuditId), eq(aeoAudits.tenantId, data.tenantId)));
  if (!auditRow) throw new Error(`AEO audit ${aeoAuditId} not found`);

  await db.update(aeoAudits).set({ status: "crawling" }).where(eq(aeoAudits.id, aeoAuditId));

  try {
    const pages = await crawlSite(auditRow.targetUrl, 12);
    const signals = pages.map(extractSignals);

    await db
      .update(aeoAudits)
      .set({ status: "analyzing", pagesCrawled: pages.length })
      .where(eq(aeoAudits.id, aeoAuditId));

    // Hard-signal dimension scores (deterministic)
    const pct = (n: number, d: number) => (d === 0 ? 0 : (n / d) * 100);
    const structuredData = pct(signals.filter((s) => s.hasJsonLd).length, signals.length);
    const schemaMarkup = pct(
      signals.filter((s) => s.jsonLdTypes.length + s.schemaTypes.length > 0).length,
      signals.length
    );
    const answerability = Math.min(
      100,
      (signals.reduce((a, s) => a + s.questionHeadings, 0) / Math.max(signals.length, 1)) * 25
    );
    const citeableQuotes = Math.min(
      100,
      (signals.reduce((a, s) => a + s.shortAnswerBlocks, 0) / Math.max(signals.length, 1)) * 10
    );

    const ctx = {
      tenantId: data.tenantId,
      clientId: auditRow.clientId,
      feature: "aeo_audit",
      aiJobId: data.aiJobId,
    };

    const aiResult = await aiCompleteJson<{
      pageFindings: { url: string; score: number; issues: string[]; strengths: string[] }[];
      recommendations: { priority: "high" | "medium" | "low"; recommendation: string; rationale: string }[];
      contentQualityScore: number;
    }>(
      `You are an AEO (Answer Engine Optimization) specialist evaluating whether content is structured for generative AI search engines (citeable quotes, direct answers, structured data, entity clarity).

CRAWLED PAGE SIGNALS (real crawl of ${auditRow.targetUrl}):
${JSON.stringify(signals)}

SAMPLE PAGE COPY (first page, 2500 chars):
${pages[0]?.text.slice(0, 2500) ?? "(no copy retrieved)"}

Return strict JSON:
- "pageFindings": one per crawled URL [{url, score: 0-100, issues[], strengths[]}]
- "recommendations": 4-8 prioritized [{priority, recommendation, rationale}] focused on schema markup, citeable quote structure, answer-first copy and entity disambiguation
- "contentQualityScore": 0-100 for LLM-citeability of the copy itself.`,
      ctx,
      { maxTokens: 5000 }
    );

    const dimensionScores = {
      structuredData: Math.round(structuredData),
      schemaMarkup: Math.round(schemaMarkup),
      answerability: Math.round(answerability),
      citeableQuotes: Math.round(citeableQuotes),
      contentQuality: Math.round(aiResult.contentQualityScore),
    };
    const overall =
      Math.round(
        (dimensionScores.structuredData * 0.25 +
          dimensionScores.schemaMarkup * 0.2 +
          dimensionScores.answerability * 0.2 +
          dimensionScores.citeableQuotes * 0.15 +
          dimensionScores.contentQuality * 0.2) * 100
      ) / 100;

    const confidence = computeConfidence({
      evidenceCount: signals.length * 6,
      dataWindowDays: 1,
      dataFreshnessHours: 0.5,
      variability: 0.2,
      sourceCount: 1,
    });

    await db
      .update(aeoAudits)
      .set({
        status: "completed",
        overallScore: String(overall),
        dimensionScores,
        pageFindings: aiResult.pageFindings,
        recommendations: aiResult.recommendations,
        confidenceScore: String(confidence.score),
        completedAt: new Date(),
      })
      .where(eq(aeoAudits.id, aeoAuditId));

    await publishEvent({
      tenantId: data.tenantId,
      eventType: EVENT_TYPES.aeoAuditCompleted,
      entityType: "aeo_audit",
      entityId: aeoAuditId,
      payload: { clientId: auditRow.clientId, overallScore: overall },
    });
  } catch (err) {
    await db
      .update(aeoAudits)
      .set({ status: "failed", error: (err as Error).message })
      .where(eq(aeoAudits.id, aeoAuditId));
    throw err;
  }
}
