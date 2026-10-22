import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/shell";
import { ToastProvider } from "@/components/ui/toast";
import { getActingContext } from "@/lib/auth/session";
import { tenantThemeStyle, type TenantBranding } from "@/lib/brand";
import { can } from "@/lib/auth/rbac";
import { PLATFORM_TENANT_SLUG } from "@/modules/platform/service";

/**
 * Every dashboard page sits under this layout, so this is the authoritative
 * sign-in gate: no valid session or embed token, no dashboard. The proxy only
 * short-circuits requests that carry no credential cookie at all.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActingContext();
  if (!ctx) redirect("/login");

  const branding = (ctx.branding as TenantBranding | null) ?? null;
  const productName = branding?.productName;
  const platform = can(ctx.role, "platform:manage");

  return (
    <div style={tenantThemeStyle(branding)}>
      <ToastProvider>
        <DashboardShell
          tenantName={ctx.tenantName}
          tenantLabel={platform && ctx.tenantSlug === PLATFORM_TENANT_SLUG ? "platform" : "clinic"}
          productName={productName}
          logoUrl={branding?.logoUrl ?? null}
          platform={platform}
          user={{
            email: ctx.email,
            fullName: ctx.fullName,
            role: ctx.role,
            canSignOut: ctx.auth.method === "session",
          }}
        >
          {children}
        </DashboardShell>
      </ToastProvider>
    </div>
  );
}
