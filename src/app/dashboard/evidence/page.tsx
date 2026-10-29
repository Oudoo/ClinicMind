import type { Metadata } from "next";
import { getActingContext } from "@/lib/auth/session";
import { can, canApproveEvidence } from "@/lib/auth/rbac";
import { listSources } from "@/modules/evidence/service";
import { EvidenceLibrary } from "@/components/clinicmind/evidence-library";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Evidence library" };

/**
 * `/dashboard/evidence?source=` — the clinic's evidence library: the
 * guidelines, drug information and protocols the evidence panel may quote.
 * `?source=` opens one (the panel's "Open in the library").
 */
export default async function EvidencePage({ searchParams }: { searchParams: Promise<{ source?: string | string[] }> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const header = (
    <SectionTitle
      title="Evidence library"
      description="What the evidence panel may quote, word for word: guidelines, drug information and the clinic's own protocols. Doctors add sources; the owner approves them."
    />
  );
  if (!can(ctx.role, "evidence:read")) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState title="The evidence library is not available for your role" hint="Doctors and the clinic owner keep the library." />
        </Card>
      </div>
    );
  }

  const sources = await listSources(ctx.tenantId);
  const source = Array.isArray(sp.source) ? sp.source[0] : sp.source;
  return (
    <div className="space-y-6">
      {header}
      <EvidenceLibrary
        sources={sources}
        canWrite={can(ctx.role, "evidence:write")}
        canApprove={canApproveEvidence(ctx)}
        openId={source && sources.some((s) => s.id === source) ? source : undefined}
      />
    </div>
  );
}
