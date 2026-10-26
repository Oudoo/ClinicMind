import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getTenantTimezone } from "@/modules/appointments/service";
import { countSubmissionsByStatus, listIntakeLinks, listSubmissions } from "@/modules/intake/service";
import { listTreatments } from "@/modules/treatments/service";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntakeReviewQueue, type QueueStatus } from "@/components/clinicmind/intake-review-queue";
import { IntakeLinksTable } from "@/components/clinicmind/intake-links-table";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const STATUSES: QueueStatus[] = ["PENDING", "ACCEPTED", "REJECTED", "all"];

/**
 * `/dashboard/patients/intake?status=PENDING|ACCEPTED|REJECTED|all&page=&tab=links`
 * — the reception queue for onboarding forms and the list of links.
 */
export default async function IntakePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "patients:write")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Onboarding" description="Shareable onboarding links and the forms patients send back." />
        <Card>
          <EmptyState title="Onboarding is not available for your role" hint="Reception, nurses, doctors and the clinic owner review onboarding forms." />
        </Card>
      </div>
    );
  }

  const statusRaw = first(sp.status) ?? "PENDING";
  const status: QueueStatus = STATUSES.includes(statusRaw as QueueStatus) ? (statusRaw as QueueStatus) : "PENDING";
  const page = Number.parseInt(first(sp.page) ?? "1", 10) || 1;
  const tab = first(sp.tab) === "links" ? "links" : "submissions";

  const timezone = await getTenantTimezone(ctx.tenantId);
  const [result, counts, { links }, treatments] = await Promise.all([
    listSubmissions(ctx.tenantId, { status, page, pageSize: 20 }),
    countSubmissionsByStatus(ctx.tenantId),
    listIntakeLinks(ctx.tenantId, { pageSize: 100 }),
    listTreatments(ctx.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <Link href="/dashboard/patients" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Patients
      </Link>

      <SectionTitle
        title="Onboarding"
        description="Shareable onboarding links and the forms patients send back from their phones."
        action={
          <Badge tone={counts.PENDING ? "warning" : "default"}>
            {counts.PENDING} pending
          </Badge>
        }
      />

      <Tabs defaultValue={tab}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="submissions">
            Submissions
            {counts.PENDING ? <Badge tone="warning" className="ml-2">{counts.PENDING}</Badge> : null}
          </TabsTrigger>
          <TabsTrigger value="links">
            Links
            <Badge className="ml-2">{links.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="submissions" className="space-y-4">
          <IntakeReviewQueue
            submissions={result.submissions}
            status={status}
            counts={counts}
            timezone={timezone}
            treatments={treatments.map((t) => ({ key: t.key, name: t.name }))}
          />
          {result.total > result.pageSize ? (
            <Card className="p-0">
              <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/dashboard/patients/intake" query={{ status }} />
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="links">
          <IntakeLinksTable links={links} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
