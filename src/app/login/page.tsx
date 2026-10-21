import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { safeRedirectPath } from "@/lib/auth/request";
import { getActingContext } from "@/lib/auth/session";
import { resolveTenantHintFromHost } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeRedirectPath(searchParams.next);

  // Already signed in (or framed with a valid embed token): nothing to do here.
  if (await getActingContext()) redirect(next ?? "/dashboard");

  // On a tenant subdomain the clinic is known; on the apex host it is inferred
  // from the e-mail and only asked for when ambiguous.
  const tenantHint = resolveTenantHintFromHost(headers().get("host")).slug ?? "";

  return (
    <AuthCard
      title="Sign in"
      description="Use the e-mail address and password of your clinic account."
      footer="Access is restricted to invited staff. Contact your clinic administrator for an invitation."
    >
      <LoginForm next={next} tenantHint={tenantHint} />
    </AuthCard>
  );
}
