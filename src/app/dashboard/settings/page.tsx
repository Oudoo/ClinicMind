import { getActingContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { Card, SectionTitle, Badge } from "@/components/ui/primitives";
import { EmbedInstructions } from "@/components/clinicmind/embed-instructions";
import { BRAND, type TenantBranding } from "@/lib/brand";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const tenant = await db.tenant
    .findUnique({
      where: { id: ctx.tenantId },
      include: { embed: true },
    })
    .catch(() => null);

  const branding = (ctx.branding as TenantBranding | null) ?? null;
  const accent = branding?.accent ?? BRAND.primitives.electricIndigo;
  const publicKey = tenant?.embed?.publicKey ?? "—";

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Settings & Integration"
        description="White-label this tenant, connect a custom domain, and embed ClinicMind anywhere."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <SectionTitle title="Branding" description="Each client runs their own white-labeled version." />
          <Row label="Product name" value={branding?.productName ?? BRAND.productName} />
          <Row
            label="Accent color"
            value={
              <span className="flex items-center gap-2">
                <span
                  className="h-4 w-4 rounded border border-border"
                  style={{ background: accent }}
                />
                <span className="font-mono text-xs">{accent}</span>
              </span>
            }
          />
          <Row label="Logo" value={branding?.logoUrl ? "Custom" : "Default"} />
        </Card>

        <Card className="space-y-4">
          <SectionTitle title="Custom Domain" description="Serve the tool from the client's own domain." />
          <Row
            label="Domain"
            value={tenant?.customDomain ?? <span className="text-muted-foreground">not set</span>}
          />
          <Row
            label="Status"
            value={
              tenant?.customDomainVerified ? (
                <Badge tone="success">verified</Badge>
              ) : (
                <Badge tone="warning">pending DNS</Badge>
              )
            }
          />
          <Row label="Subdomain" value={`${ctx.tenantSlug}.${env.ROOT_DOMAIN}`} />
        </Card>
      </div>

      <Card className="space-y-4">
        <SectionTitle
          title="Embed on your website"
          description="Drop ClinicMind into the client's site or the GROW Engine dashboard as a tab."
          action={
            <Badge tone={tenant?.embed?.enabled ? "success" : "default"}>
              {tenant?.embed?.enabled ? "embedding enabled" : "embedding off"}
            </Badge>
          }
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Row label="Public key" value={<span className="font-mono text-xs">{publicKey}</span>} />
          <Row
            label="Allowed origins"
            value={
              tenant?.embed?.allowedOrigins?.length
                ? tenant.embed.allowedOrigins.join(", ")
                : "none configured"
            }
          />
        </div>
        <EmbedInstructions
          appUrl={env.APP_URL}
          tenantSlug={ctx.tenantSlug}
          publicKey={publicKey}
        />
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="data-label">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}
