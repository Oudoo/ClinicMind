import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/shell";
import { ToastProvider } from "@/components/ui/toast";
import { getActingContext } from "@/lib/auth/session";
import { tenantThemeStyle, type TenantBranding } from "@/lib/brand";

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

  return (
    <div style={tenantThemeStyle(branding)}>
      <ToastProvider>
        <DashboardShell
          tenantName={ctx.tenantName}
          productName={productName}
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
