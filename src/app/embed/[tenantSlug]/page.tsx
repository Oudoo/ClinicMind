import { db, notDeleted } from "@/lib/db";
import { EmbedBootstrap } from "@/components/clinicmind/embed-bootstrap";
import { tenantThemeStyle, BRAND, type TenantBranding } from "@/lib/brand";

export const dynamic = "force-dynamic";

/**
 * Public embeddable surface for a tenant. Framed by the client's website or the
 * GROW Engine dashboard. Branding is resolved server-side so the first paint is
 * already white-labeled; authentication is bootstrapped client-side via the
 * embed token relay.
 */
export default async function EmbedPage({ params }: { params: { tenantSlug: string } }) {
  const tenant = await db.tenant
    .findFirst({
      where: { slug: params.tenantSlug, status: "ACTIVE", ...notDeleted },
      select: { name: true, branding: true },
    })
    .catch(() => null);

  const branding = (tenant?.branding as TenantBranding | null) ?? null;
  const productName = branding?.productName ?? BRAND.productName;

  return (
    <div style={tenantThemeStyle(branding)}>
      <EmbedBootstrap tenantSlug={params.tenantSlug} productName={productName} />
    </div>
  );
}
