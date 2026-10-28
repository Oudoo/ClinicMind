import { notDeleted, systemDb } from "@/lib/db";
import { EmbedBootstrap } from "@/components/clinicmind/embed-bootstrap";
import { tenantThemeStyle, BRAND, type TenantBranding } from "@/lib/brand";

export const dynamic = "force-dynamic";

/**
 * Public embeddable surface for a tenant. Framed by the clinic's website or
 * another portal of theirs. Branding is resolved server-side so the first paint
 * is already white-labeled; authentication is bootstrapped client-side via the
 * embed token relay, and only the tenant's allow-listed origins may take part
 * (the proxy also emits a matching `frame-ancestors` policy).
 */
export default async function EmbedPage({ params }: { params: Promise<{ tenantSlug: string }> }) {
  const { tenantSlug } = await params;
  const tenant = await systemDb.tenant
    .findFirst({
      where: { slug: tenantSlug, status: "ACTIVE", ...notDeleted },
      select: { name: true, branding: true, embed: { select: { enabled: true, allowedOrigins: true } } },
    })
    .catch(() => null);

  const branding = (tenant?.branding as TenantBranding | null) ?? null;
  const productName = branding?.productName ?? BRAND.productName;

  if (!tenant || !tenant.embed?.enabled) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-center">
        <p className="text-sm font-medium">Embedding is not available</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {tenant ? "This clinic has not enabled the embedded surface." : "Unknown clinic."}
        </p>
      </div>
    );
  }

  return (
    <div style={tenantThemeStyle(branding)}>
      <EmbedBootstrap
        tenantSlug={tenantSlug}
        productName={productName}
        allowedOrigins={tenant.embed.allowedOrigins}
      />
    </div>
  );
}
