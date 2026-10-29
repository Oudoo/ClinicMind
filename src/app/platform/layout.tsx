import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/shell";
import { ToastProvider } from "@/components/ui/toast";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { tenantThemeStyle, type TenantBranding } from "@/lib/brand";

/**
 * The platform (system-owner) console. Only SUPER_ADMIN holds
 * `platform:manage`; everyone else is sent to their clinic dashboard.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActingContext();
  if (!ctx) redirect("/login?next=/platform");
  if (!can(ctx.role, "platform:manage")) redirect("/dashboard");

  const branding = (ctx.branding as TenantBranding | null) ?? null;

  return (
    <div style={tenantThemeStyle(branding)}>
      <ToastProvider>
        <DashboardShell
          tenantName={ctx.tenantName}
          tenantLabel="platform"
          productName={branding?.productName}
          logoUrl={branding?.logoUrl ?? null}
          platform
          user={{ email: ctx.email, fullName: ctx.fullName, role: ctx.role, isClinician: ctx.isClinician, canSignOut: ctx.auth.method === "session" }}
        >
          {children}
        </DashboardShell>
      </ToastProvider>
    </div>
  );
}
