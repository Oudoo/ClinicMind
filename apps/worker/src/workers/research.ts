import { Worker, type Job } from "bullmq";
import {
  db,
  knowledgeDocuments,
} from "@growengine/db";
import {
  bullConnectionOptions,
  QUEUE_NAMES,
  crawlSite,
  searchMentions,
  aiComplete,
  indexEntity,
  type ResearchJobData,
} from "@growengine/core";
import { markJobStatus } from "../lib/track.js";

/**
 * Research Worker — competitor analysis and open-web monitoring built on
 * direct fetch + Cheerio + RSS (near-zero licensing cost; ScraperAPI only
 * as configured fallback inside the crawler).
 */

async function handleCompetitorAnalysis(data: ResearchJobData) {
  const { competitorUrl, competitorName } = data.input as {
    competitorUrl: string;
    competitorName: string;
  };

  const pages = await crawlSite(competitorUrl, 8);
  const mentions = await searchMentions(competitorName);

  const ctx = {
    tenantId: data.tenantId,
    clientId: data.clientId,
    feature: "competitor_analysis",
  };

  const markdown = await aiComplete(
    `You are a competitive intelligence analyst. Produce a competitor analysis in markdown for "${competitorName}".

LIVE SITE CRAWL (${pages.length} pages):
${JSON.stringify(
      pages.map((p) => ({
        url: p.url,
        title: p.title,
        metaDescription: p.metaDescription,
        headings: p.headings.slice(0, 10),
        wordCount: p.wordCount,
      }))
    )}

RECENT PRESS/NEWS MENTIONS (RSS, real):
${JSON.stringify(mentions.slice(0, 15))}

Sections: Positioning & Messaging, Product/Service Focus, Content Strategy Signals, Recent News & PR, Implications For Us. Ground every statement in the crawl or the mentions; cite URLs inline.`,
    ctx,
    { maxTokens: 5000 }
  );

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: data.tenantId,
      clientId: data.clientId ?? null,
      type: "research",
      title: `Competitor Analysis — ${competitorName} — ${new Date().toISOString().slice(0, 10)}`,
      contentMarkdown: markdown,
      tags: ["competitor", competitorName],
    })
    .returning();

  try {
    await indexEntity(
      {
        tenantId: data.tenantId,
        clientId: data.clientId ?? null,
        entityType: "knowledge_document",
        entityId: doc.id,
        text: markdown,
      },
      ctx
    );
  } catch {
    /* embeddings optional */
  }
  return { documentId: doc.id, pagesCrawled: pages.length, mentions: mentions.length };
}

async function handlePrMentions(data: ResearchJobData) {
  const { query, feeds } = data.input as { query: string; feeds?: string[] };
  const mentions = await searchMentions(query, feeds ?? []);
  if (mentions.length === 0) return { mentions: 0 };

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: data.tenantId,
      clientId: data.clientId ?? null,
      type: "research",
      title: `PR Mentions — "${query}" — ${new Date().toISOString().slice(0, 10)}`,
      contentMarkdown: mentions
        .map((m) => `- [${m.title}](${m.link}) — ${m.source}${m.publishedAt ? ` (${m.publishedAt.slice(0, 10)})` : ""}\n  ${m.snippet}`)
        .join("\n"),
      tags: ["pr_mentions", query],
    })
    .returning();
  return { documentId: doc.id, mentions: mentions.length };
}

async function handleWebCrawl(data: ResearchJobData) {
  const { url, maxPages } = data.input as { url: string; maxPages?: number };
  const pages = await crawlSite(url, maxPages ?? 10);
  return {
    pagesCrawled: pages.length,
    pages: pages.map((p) => ({ url: p.url, title: p.title, wordCount: p.wordCount })),
  };
}

export function createResearchWorker() {
  const worker = new Worker<ResearchJobData>(
    QUEUE_NAMES.research,
    async (job: Job<ResearchJobData>) => {
      await markJobStatus(job, "active");
      switch (job.data.operation) {
        case "competitor_analysis":
          return handleCompetitorAnalysis(job.data);
        case "pr_mentions":
        case "rss_monitor":
          return handlePrMentions(job.data);
        case "web_crawl":
          return handleWebCrawl(job.data);
      }
    },
    { connection: bullConnectionOptions(), concurrency: 2 }
  );
  worker.on("completed", (job) => markJobStatus(job, "completed"));
  worker.on("failed", (job, err) => job && markJobStatus(job, "failed", err.message));
  return worker;
}
