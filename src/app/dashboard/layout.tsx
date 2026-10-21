import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/shell";
import { getActingContext } from "@/lib/auth/session";
import { tenantThemeStyle, type TenantBranding } from "@/lib/brand";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActingContext();
  if (!ctx) redirect("/");

  const branding = (ctx.branding as TenantBranding | null) ?? null;
  const productName = branding?.productName;

  return (
    <div style={tenantThemeStyle(branding)}>
      <DashboardShell tenantName={ctx.tenantName} productName={productName}>
        {children}
      </DashboardShell>
    </div>
  );
}
