import { and, desc, eq, sql as dsql } from "drizzle-orm";
import {
  db,
  aomEmbeddings,
  aomLinks,
  recommendations,
  decisions,
} from "@growengine/db";
import { chunkText, embedTexts } from "./ai/embeddings.js";
import { env } from "./env.js";
import type { AiCallContext } from "./ai/provider.js";

/**
 * Agency Operating Memory service — indexes entities into the pgvector
 * semantic layer, maintains the entity link graph, and answers historical
 * context queries ("every recommendation made to this client in 18 months,
 * which were approved, and their impact").
 */

export interface IndexEntityInput {
  tenantId: string;
  clientId?: string | null;
  entityType: string;
  entityId: string;
  /** Full text to index; will be chunked + embedded. */
  text: string;
}

export async function indexEntity(input: IndexEntityInput, ctx: AiCallContext) {
  const chunks = chunkText(input.text);
  if (chunks.length === 0) return 0;

  // Re-index: drop stale chunks for this entity first
  await db
    .delete(aomEmbeddings)
    .where(
      and(
        eq(aomEmbeddings.tenantId, input.tenantId),
        eq(aomEmbeddings.entityType, input.entityType),
        eq(aomEmbeddings.entityId, input.entityId)
      )
    );

  const vectors = await embedTexts(chunks, { ...ctx, feature: "aom_indexing" });
  await db.insert(aomEmbeddings).values(
    chunks.map((chunk, i) => ({
      tenantId: input.tenantId,
      clientId: input.clientId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      chunkIndex: i,
      chunkText: chunk,
      embedding: vectors[i],
      embeddingModel: env.embeddingModel,
    }))
  );
  return chunks.length;
}

export interface SemanticSearchResult {
  entityType: string;
  entityId: string;
  clientId: string | null;
  chunkText: string;
  similarity: number;
}

/**
 * Semantic search across the AOM, strictly scoped to one tenant.
 */
export async function semanticSearch(
  tenantId: string,
  query: string,
  ctx: AiCallContext,
  opts: { clientId?: string; entityTypes?: string[]; limit?: number } = {}
): Promise<SemanticSearchResult[]> {
  const [queryVector] = await embedTexts([query], { ...ctx, feature: "aom_search" });
  const vectorLiteral = `[${queryVector.join(",")}]`;

  const conditions = [eq(aomEmbeddings.tenantId, tenantId)];
  if (opts.clientId) conditions.push(eq(aomEmbeddings.clientId, opts.clientId));

  const similarity = dsql<number>`1 - (${aomEmbeddings.embedding} <=> ${vectorLiteral}::vector)`;

  let queryBuilder = db
    .select({
      entityType: aomEmbeddings.entityType,
      entityId: aomEmbeddings.entityId,
      clientId: aomEmbeddings.clientId,
      chunkText: aomEmbeddings.chunkText,
      similarity,
    })
    .from(aomEmbeddings)
    .where(and(...conditions))
    .orderBy(dsql`${aomEmbeddings.embedding} <=> ${vectorLiteral}::vector`)
    .limit(opts.limit ?? 12)
    .$dynamic();

  const rows = await queryBuilder;
  const filtered = opts.entityTypes?.length
    ? rows.filter((r) => opts.entityTypes!.includes(r.entityType))
    : rows;
  return filtered.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

export async function linkEntities(input: {
  tenantId: string;
  fromEntityType: string;
  fromEntityId: string;
  toEntityType: string;
  toEntityId: string;
  linkType?: string;
}) {
  await db.insert(aomLinks).values({
    tenantId: input.tenantId,
    fromEntityType: input.fromEntityType,
    fromEntityId: input.fromEntityId,
    toEntityType: input.toEntityType,
    toEntityId: input.toEntityId,
    linkType: input.linkType ?? "references",
  });
}

/**
 * Historical context query: recommendations for a client over a window,
 * with decision outcomes and measured impact — the canonical AOM query.
 */
export async function recommendationHistory(
  tenantId: string,
  clientId: string,
  sinceMonths = 18
) {
  const since = new Date();
  since.setMonth(since.getMonth() - sinceMonths);

  const recs = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.tenantId, tenantId),
        eq(recommendations.clientId, clientId),
        dsql`${recommendations.createdAt} >= ${since.toISOString()}`
      )
    )
    .orderBy(desc(recommendations.createdAt));

  const recDecisions = await db
    .select()
    .from(decisions)
    .where(
      and(
        eq(decisions.tenantId, tenantId),
        eq(decisions.clientId, clientId),
        eq(decisions.sourceEntityType, "recommendation")
      )
    );

  const decisionByRec = new Map(recDecisions.map((d) => [d.sourceEntityId, d]));
  return recs.map((rec) => ({
    ...rec,
    decision: decisionByRec.get(rec.id) ?? null,
  }));
}
