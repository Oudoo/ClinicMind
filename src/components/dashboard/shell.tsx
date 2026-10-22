"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Stethoscope,
  Sparkles,
  MessagesSquare,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu, type ShellUser } from "@/components/dashboard/user-menu";

export type { ShellUser };

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/patients", label: "Patients", icon: Users },
  { href: "/dashboard/appointments", label: "Appointments", icon: CalendarDays },
  { href: "/dashboard/consultations", label: "Consultations", icon: Stethoscope },
  { href: "/dashboard/assistant", label: "AI Assistant", icon: Sparkles, badge: "RAG" },
  { href: "/dashboard/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

/**
 * The ClinicMind application shell: sidebar navigation (drawer on small
 * screens), top bar with breadcrumb, theme switch and account menu.
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
  const current = NAV.find((n) => isActive(pathname, n.href));
  const [open, setOpen] = useState(false);

  const nav = (
    <nav className="flex-1 space-y-0.5 p-3" aria-label="Main">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center justify-between rounded-md px-3 py-2 text-sm transition-colors",
              active ? "bg-accent-muted font-medium text-accent" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
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
  );

  const brand = (
    <div className="flex h-14 items-center gap-2 border-b border-border px-5">
      {/* Swap the logo by replacing /public/logo.svg */}
      <img src="/logo.svg" alt="" width={28} height={28} className="h-7 w-7 rounded-md" />
      <div className="flex flex-col leading-none">
        <span className="font-display text-sm font-semibold tracking-tight">{productName}</span>
        <span className="font-mono text-[10px] text-muted-foreground">clinic operating system</span>
      </div>
    </div>
  );

  const tenantCard = (
    <div className="border-t border-border p-3">
      <div className="rounded-md bg-muted px-3 py-2">
        <p className="data-label">clinic</p>
        <p className="truncate text-sm font-medium">{tenantName}</p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        {brand}
        {nav}
        {tenantCard}
      </aside>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-charcoal-slate/40 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-card shadow-xl focus:outline-none lg:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex items-center justify-between pr-2">
              {brand}
              <DialogPrimitive.Close className="rounded-md p-2 text-muted-foreground hover:bg-muted" aria-label="Close navigation">
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            {nav}
            {tenantCard}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-card/70 px-4 backdrop-blur-glass sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              <DialogPrimitive.Trigger asChild>
                <button className="rounded-md p-2 text-muted-foreground hover:bg-muted lg:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </button>
              </DialogPrimitive.Trigger>
              <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">{tenantName}</span>
              <span className="hidden text-muted-foreground sm:inline">/</span>
              <span className="truncate text-sm font-medium">{current?.label ?? "Overview"}</span>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              <ThemeToggle />
              <UserMenu user={user} />
            </div>
          </header>
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
        </div>
      </DialogPrimitive.Root>
    </div>
  );
}
