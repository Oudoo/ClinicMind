import { db } from "../src/lib/db";
import { aiStatus } from "../src/lib/ai/provider";
import { reindexTenant } from "../src/modules/knowledge/ingest";

/**
 * Rebuild the RAG store for one tenant or for every active tenant.
 *
 *   npm run ai:reindex -- <tenant-slug>
 *   npm run ai:reindex -- --all
 *
 * Unchanged chunks are skipped (content hash + embedding model), so re-running
 * is cheap; switching AI_EMBEDDING_PROVIDER or the embedding model re-embeds
 * everything on the next run. Needs DATABASE_URL and, for real embeddings, the
 * provider key; without a key the offline `echo` embeddings are written.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const all = args.includes("--all");
  const slug = args.find((a) => !a.startsWith("--"));

  if (!all && !slug) {
    console.error("usage: npm run ai:reindex -- <tenant-slug> | --all");
    process.exitCode = 2;
    return;
  }

  const tenants = all
    ? await db.tenant.findMany({ where: { deletedAt: null, status: "ACTIVE" }, select: { id: true, slug: true }, orderBy: { slug: "asc" } })
    : await db.tenant.findMany({ where: { slug: slug!, deletedAt: null }, select: { id: true, slug: true } });

  if (!tenants.length) {
    console.error(all ? "no active tenants found" : `tenant "${slug}" not found`);
    process.exitCode = 1;
    return;
  }

  const status = aiStatus();
  console.log(`embeddings: ${status.embeddings.provider} (${status.embeddings.model || "n/a"})${status.embeddings.configured ? "" : " — offline echo embeddings, configure GEMINI_API_KEY or OPENAI_API_KEY for real retrieval"}`);

  let failed = 0;
  for (const tenant of tenants) {
    console.log(`\n[${tenant.slug}] re-indexing…`);
    const counts = await reindexTenant(tenant.id, { log: (line) => console.log(`[${tenant.slug}] ${line}`) });
    if (counts.errors) failed += counts.errors;
  }
  if (failed) {
    console.error(`\n${failed} record(s) failed to index; see [knowledge] errors above`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
