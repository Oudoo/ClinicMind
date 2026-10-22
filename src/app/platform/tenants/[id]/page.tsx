import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge, Bento, Card, Metric, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { BrandingForm, DomainForm, OwnerInviteForm, TenantStatusActions } from "@/components/platform/tenant-admin";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/utils";
import { getTenantDetail } from "@/modules/platform/service";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "default" | "success" | "warning" | "danger"> = {
  ACTIVE: "success",
  PROVISIONING: "warning",
  SUSPENDED: "danger",
  ARCHIVED: "default",
};
const USER_TONE: Record<string, "default" | "success" | "warning" | "danger"> = {
  ACTIVE: "success",
  INVITED: "warning",
  DISABLED: "danger",
};

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantDetail(id);
  if (!tenant) notFound();

  const scheme = env.APP_URL.startsWith("https") ? "https" : "http";
  const address =
    tenant.customDomain && tenant.customDomainVerified
      ? `https://${tenant.customDomain}`
      : `${scheme}://${tenant.slug}.${env.ROOT_DOMAIN}`;

  return (
    <div className="space-y-6">
      <Link href="/platform" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Platform console
      </Link>

      <Card className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold tracking-tight">{tenant.name}</h1>
            <Badge tone={STATUS_TONE[tenant.status] ?? "default"}>{tenant.status.toLowerCase()}</Badge>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {tenant.slug} · created {tenant.createdAt ? formatDate(tenant.createdAt) : "—"}
            {tenant.branding.productName ? ` · branded as “${tenant.branding.productName}”` : ""}
          </p>
          <a href={`${address}/login`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">
            {address} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TenantStatusActions tenantId={tenant.id} status={tenant.status} name={tenant.name} />
        </div>
      </Card>

      <Bento>
        <Metric label="Staff accounts" value={tenant.counts.users} />
        <Metric label="Patients" value={tenant.counts.patients} tone="accent" />
        <Metric label="Appointments" value={tenant.counts.appointments} />
        <Metric label="Signed visits" value={tenant.counts.visits} />
      </Bento>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <SectionTitle title="White-label" description="Product name, accent colour and logo shown to this tenant's staff and on its sign-in page." />
          <BrandingForm initial={tenant.branding} target={{ kind: "platform", tenantId: tenant.id }} fallbackProductName="ClinicMind" />
        </Card>
        <Card className="space-y-4">
          <SectionTitle
            title="Domain & embedding"
            description={`Subdomain ${tenant.slug}.${env.ROOT_DOMAIN} always works. A custom domain is served once DNS points here and it is marked verified.`}
          />
          <DomainForm
            tenantId={tenant.id}
            initial={{
              customDomain: tenant.customDomain,
              customDomainVerified: tenant.customDomainVerified,
              embedEnabled: tenant.embed?.enabled ?? false,
              allowedOrigins: tenant.embed?.allowedOrigins ?? [],
            }}
          />
          <p className="text-xs text-muted-foreground">
            Embed secret: {tenant.embed?.secretPrefix ? <code className="font-mono">{tenant.embed.secretPrefix}…</code> : "none"}
            {tenant.embed?.secretRotatedAt ? ` · rotated ${formatDate(tenant.embed.secretRotatedAt)}` : ""}. The clinic owner rotates it from their Settings.
          </p>
        </Card>
      </div>

      <Card className="space-y-4">
        <SectionTitle
          title="Owner & staff"
          description="The clinic owner manages everything inside the tenant: staff invitations, branding, embedding, and the clinical work."
          action={<Badge tone="accent">{tenant.users.length} accounts</Badge>}
        />
        {tenant.users.length ? (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Member</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH>Since</TH>
                </TR>
              </THead>
              <TBody>
                {tenant.users.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <div className="font-medium">{u.fullName ?? u.email}</div>
                      {u.fullName ? <div className="font-mono text-xs text-muted-foreground">{u.email}</div> : null}
                    </TD>
                    <TD className="font-mono text-xs uppercase text-muted-foreground">{u.role.replace("_", " ")}</TD>
                    <TD>
                      <Badge tone={USER_TONE[u.status] ?? "default"}>{u.status.toLowerCase()}</Badge>
                    </TD>
                    <TD className="font-mono text-xs text-muted-foreground">{u.createdAt ? formatDate(u.createdAt) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : null}
        <div className="border-t border-border pt-4">
          <p className="data-label mb-3">{tenant.owner?.status === "INVITED" ? "Owner invitation" : "Invite an owner"}</p>
          <OwnerInviteForm tenantId={tenant.id} owner={tenant.owner} />
        </div>
      </Card>
    </div>
  );
}
