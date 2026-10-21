"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Stethoscope,
  Sparkles,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { Badge } from "@/components/ui/primitives";
import { LogoutButton } from "@/components/dashboard/logout-button";

export interface ShellUser {
  email: string | null;
  fullName: string | null;
  role: string;
  /** False for embed-token sessions, which have nothing to sign out of here. */
  canSignOut: boolean;
}

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/patients", label: "Patients", icon: Users },
  { href: "/dashboard/appointments", label: "Appointments", icon: CalendarDays },
  { href: "/dashboard/consultations", label: "Consultations", icon: Stethoscope },
  { href: "/dashboard/assistant", label: "AI Assistant", icon: Sparkles, badge: "RAG" },
  { href: "/dashboard/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

/**
 * The ClinicMind application shell: sidebar navigation, top bar and content area.
 */
export function DashboardShell({
  children,
  tenantName,
  productName = BRAND.productName,
  user,
}: {
  children: React.ReactNode;
  tenantName: string;
  productName?: string;
  user: ShellUser;
}) {
  const pathname = usePathname() ?? "/dashboard";
  const currentLabel =
    NAV.find((n) => n.href === pathname || (n.href !== "/dashboard" && pathname.startsWith(n.href)))
      ?.label ?? "Overview";

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5">
          {/* Swap the logo by replacing /public/logo.svg */}
          <img src="/logo.svg" alt={productName} width={28} height={28} className="h-7 w-7 rounded-md" />
          <div className="flex flex-col leading-none">
            <span className="font-display text-sm font-semibold tracking-tight">{productName}</span>
            <span className="font-mono text-[10px] text-muted-foreground">medical ai os</span>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-accent-muted font-medium text-accent"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </span>
                {"badge" in item && item.badge ? <Badge tone="accent">{item.badge}</Badge> : null}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <div className="rounded-md bg-muted px-3 py-2">
            <p className="data-label">tenant</p>
            <p className="truncate text-sm font-medium">{tenantName}</p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-card/70 px-6 backdrop-blur-glass">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{tenantName}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-medium">{currentLabel}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden flex-col items-end leading-tight sm:flex">
              <span className="text-xs font-medium">{user.fullName ?? user.email ?? "Embedded session"}</span>
              <span className="font-mono text-[10px] uppercase text-muted-foreground">{user.role}</span>
            </div>
            {user.canSignOut ? <LogoutButton /> : <Badge tone="success">live</Badge>}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
