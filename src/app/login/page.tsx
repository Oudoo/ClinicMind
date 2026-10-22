import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { safeRedirectPath } from "@/lib/auth/request";
import { getActingContext } from "@/lib/auth/session";
import { tenantThemeStyle } from "@/lib/brand";
import { getTenantContext, resolveTenantHintFromHost } from "@/lib/tenant";
import { brandingOf } from "@/modules/platform/service";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: requested } = await searchParams;
  const next = safeRedirectPath(requested);

  // Already signed in (or framed with a valid embed token): nothing to do here.
  if (await getActingContext()) redirect(next ?? "/dashboard");

  // On a tenant subdomain the clinic is known; on the apex host it is inferred
  // from the e-mail and only asked for when ambiguous.
  const host = (await headers()).get("host");
  const hint = resolveTenantHintFromHost(host);
  const tenantHint = hint.slug ?? "";
  // On a tenant's own host the sign-in page carries that tenant's brand.
  const tenant = hint.slug || hint.customDomain ? (await getTenantContext({ host }))?.tenant ?? null : null;
  const branding = brandingOf(tenant?.branding);

  return (
    <div style={tenantThemeStyle(branding)}>
      <AuthCard
        title={tenant ? `Sign in to ${tenant.name}` : "Sign in"}
        description="Use the e-mail address and password of your clinic account."
        footer="Access is restricted to invited staff. Contact your clinic administrator for an invitation."
        brand={tenant ? { name: branding.productName ?? tenant.name, logoUrl: branding.logoUrl ?? null } : undefined}
      >
        <LoginForm next={next} tenantHint={tenantHint} />
      </AuthCard>
    </div>
  );
}
