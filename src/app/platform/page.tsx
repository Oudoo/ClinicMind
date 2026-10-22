import Link from "next/link";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NewTenantDialog } from "@/components/platform/new-tenant-dialog";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/utils";
import { listTenants } from "@/modules/platform/service";

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

export default async function PlatformPage() {
  const tenants = await listTenants();
  const scheme = env.APP_URL.startsWith("https") ? "https" : "http";

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Platform console"
        description="Every client runs as an isolated, white-labeled tenant. Create one, invite its owner, and manage its domain, branding and embedding."
        action={
          <div className="flex items-center gap-3">
            <Badge tone="accent">
              {tenants.length} {tenants.length === 1 ? "tenant" : "tenants"}
            </Badge>
            <NewTenantDialog rootDomain={env.ROOT_DOMAIN} scheme={scheme} />
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        {tenants.length ? (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Tenant</TH>
                <TH>Status</TH>
                <TH>Owner</TH>
                <TH>Address</TH>
                <TH className="text-right">Users</TH>
                <TH className="text-right">Patients</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {tenants.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <Link href={`/platform/tenants/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {t.slug}
                      {t.branding.productName && t.branding.productName !== t.name ? ` · as “${t.branding.productName}”` : ""}
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONE[t.status] ?? "default"}>{t.status.toLowerCase()}</Badge>
                  </TD>
                  <TD>
                    {t.owner ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm">{t.owner.fullName ?? t.owner.email}</span>
                        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                          {t.owner.fullName ? t.owner.email : null}
                          <Badge tone={USER_TONE[t.owner.status] ?? "default"}>{t.owner.status.toLowerCase()}</Badge>
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">no owner yet</span>
                    )}
                  </TD>
                  <TD className="font-mono text-xs text-muted-foreground">
                    {t.customDomain ? (
                      <span>
                        {t.customDomain}
                        {t.customDomainVerified ? "" : " (unverified)"}
                      </span>
                    ) : (
                      `${t.slug}.${env.ROOT_DOMAIN}`
                    )}
                  </TD>
                  <TD className="text-right font-mono text-xs tabular-nums">{t.counts.users}</TD>
                  <TD className="text-right font-mono text-xs tabular-nums">{t.counts.patients}</TD>
                  <TD className="font-mono text-xs text-muted-foreground">{t.createdAt ? formatDate(t.createdAt) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState title="No tenants yet" hint="Create the first client with “New tenant”." />
          </div>
        )}
      </Card>
    </div>
  );
}
