"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { UserRole } from "@prisma/client";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Stethoscope,
  Sparkles,
  MessagesSquare,
  Settings,
  Building2,
  Workflow,
  UserPlus,
  HeartPulse,
  Banknote,
  ChartColumn,
  ChevronDown,
  ScrollText,
  Menu,
  Search,
  X,
  Tags,
  ClipboardCheck,
  FileText,
  Wallet,
  FileSpreadsheet,
  PhoneCall,
  BookOpenCheck,
  ClipboardList,
  CalendarClock,
  HandCoins,
  Receipt,
  FlaskConical,
  ShieldCheck,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { onAuthChange } from "@/lib/auth/browser-session";
import { can, type Permission } from "@/lib/auth/rbac";
import { NotificationBell } from "@/components/dashboard/notification-bell";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { UserMenu, type ShellUser } from "@/components/dashboard/user-menu";

export type { ShellUser };

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Shown only to roles holding this permission. */
  permission?: Permission;
  /** Shown only to these roles. */
  roles?: UserRole[];
  /** Shown only to clinicians (clinical questions to the AI). */
  clinician?: boolean;
  /** Other pages that belong to it (the suppliers to the expenses). */
  also?: string[];
}

/** What everyone opens every day: always in view, above the groups. */
const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/appointments", label: "Appointments", icon: CalendarDays },
  { href: "/dashboard/patients", label: "Patients", icon: Users },
];

type GroupKey = "desk" | "clinical" | "billing" | "accounts" | "clinic";

/** The rest of the application, grouped by the work it belongs to. A group a role can open nothing in is not shown. */
const GROUPS: Record<GroupKey, { label: string; items: NavItem[] }> = {
  desk: {
    label: "Front desk",
    items: [
      { href: "/dashboard/conversations", label: "Conversations", icon: MessagesSquare },
      { href: "/dashboard/recalls", label: "Recalls", icon: PhoneCall, permission: "recalls:read" },
      { href: "/dashboard/leads", label: "Leads", icon: UserPlus, permission: "leads:read" },
    ],
  },
  clinical: {
    label: "Clinical",
    items: [
      { href: "/dashboard/consultations", label: "Consultations", icon: Stethoscope, permission: "consultations:read" },
      { href: "/dashboard/quotes", label: "Treatment plans", icon: ClipboardList, permission: "quotes:read" },
      { href: "/dashboard/lab", label: "Lab work", icon: FlaskConical, permission: "lab:read" },
      { href: "/dashboard/concierge", label: "Concierge", icon: HeartPulse, permission: "concierge:read" },
      { href: "/dashboard/assistant", label: "AI Assistant", icon: Sparkles, permission: "ai:assistant", clinician: true },
      { href: "/dashboard/evidence", label: "Evidence library", icon: BookOpenCheck, permission: "evidence:read" },
    ],
  },
  billing: {
    label: "Billing",
    items: [
      { href: "/dashboard/finance/invoices", label: "Invoices", icon: FileText, permission: "payments:write" },
      { href: "/dashboard/finance/cash", label: "Cash drawer", icon: Wallet, permission: "payments:write" },
      { href: "/dashboard/finance/unbilled", label: "Not billed", icon: ClipboardCheck, permission: "payments:write" },
      { href: "/dashboard/finance/instalments", label: "Instalments", icon: CalendarClock, permission: "payments:write" },
      { href: "/dashboard/finance/insurance", label: "Insurance", icon: ShieldCheck, permission: "insurance:read" },
    ],
  },
  accounts: {
    label: "Accounts",
    items: [
      { href: "/dashboard/finance", label: "Finance", icon: Banknote, permission: "finance:read" },
      { href: "/dashboard/finance/expenses", label: "Expenses", icon: Receipt, permission: "expenses:read", also: ["/dashboard/finance/suppliers"] },
      { href: "/dashboard/finance/prices", label: "Price list", icon: Tags, permission: "patients:write" },
      { href: "/dashboard/finance/doctor-pay", label: "Doctor pay", icon: HandCoins, permission: "finance:read" },
      { href: "/dashboard/finance/doctor-pay/me", label: "My pay", icon: HandCoins, roles: ["DOCTOR", "NURSE"] },
      { href: "/dashboard/finance/reports", label: "Finance reports", icon: FileSpreadsheet, permission: "finance:read" },
    ],
  },
  clinic: {
    label: "Clinic",
    items: [
      { href: "/dashboard/reports", label: "Reports", icon: ChartColumn, permission: "reports:read" },
      { href: "/dashboard/clinic-ai", label: "Clinic AI", icon: Workflow },
      { href: "/dashboard/audit", label: "Audit log", icon: ScrollText, permission: "audit:read" },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
};

/**
 * The order of the groups and which start open, by what the role does all day: the desk leads
 * with its worklists and billing, clinicians with the clinical pages, an owner who does not
 * practise with the accounts. The group of the current page is always open.
 */
export function navPlan(role: UserRole, isClinician: boolean): { order: GroupKey[]; open: GroupKey[] } {
  switch (role) {
    case "DOCTOR":
      return { order: ["clinical", "desk", "accounts", "billing", "clinic"], open: ["clinical"] };
    case "NURSE":
      return { order: ["clinical", "desk", "billing", "accounts", "clinic"], open: ["clinical", "desk"] };
    case "CLINIC_OWNER":
    case "SUPER_ADMIN":
      return isClinician
        ? { order: ["clinical", "accounts", "desk", "billing", "clinic"], open: ["clinical", "accounts"] }
        : { order: ["accounts", "clinic", "desk", "billing", "clinical"], open: ["accounts", "clinic"] };
    default:
      return { order: ["desk", "billing", "clinical", "accounts", "clinic"], open: ["desk", "billing"] };
  }
}

/** Titles of pages reached from inside a section rather than the menu. */
const PAGE_TITLES: [prefix: string, title: string][] = [
  ["/dashboard/safety", "Safety overrides"],
  ["/dashboard/notifications", "Notifications"],
  ["/dashboard/finance/doctor-pay", "Pay statement"],
];

/** Shown to platform administrators (SUPER_ADMIN) above the clinic sections. */
const PLATFORM_NAV: NavItem = { href: "/platform", label: "Platform", icon: Building2 };

function isActive(pathname: string, href: string): boolean {
  return pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
}

// Which groups the person opened or closed, kept in this browser.
const GROUPS_KEY = "cm-nav-groups";
const GROUPS_EVENT = "cm-nav-groups-change";
function subscribeGroups(onChange: () => void) {
  window.addEventListener(GROUPS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(GROUPS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
function readGroups(): string {
  try {
    return localStorage.getItem(GROUPS_KEY) ?? "";
  } catch {
    return "";
  }
}
function parseGroups(raw: string): Partial<Record<GroupKey, boolean>> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : {};
    return value && typeof value === "object" ? (value as Partial<Record<GroupKey, boolean>>) : {};
  } catch {
    return {};
  }
}

/**
 * The ClinicMind application shell: the navigation rail (a drawer on small screens) with the
 * three everyday pages on top and the rest in groups ordered for the role, and a top bar with
 * the patient search, notifications, the theme switch and the account menu.
 */
export function DashboardShell({
  children,
  tenantName,
  productName = BRAND.productName,
  logoUrl,
  platform = false,
  user,
}: {
  children: React.ReactNode;
  tenantName: string;
  productName?: string;
  logoUrl?: string | null;
  /** Adds the platform console entry; only for users holding `platform:manage`. */
  platform?: boolean;
  user: ShellUser;
}) {
  const pathname = usePathname() ?? "/dashboard";
  const router = useRouter();
  const role = user.role as UserRole;
  const allowed = (n: NavItem) => (!n.permission || can(role, n.permission)) && (!n.roles || n.roles.includes(role)) && (!n.clinician || user.isClinician);
  const primary = [...(platform ? [PLATFORM_NAV] : []), ...PRIMARY.filter(allowed)];
  const plan = navPlan(role, user.isClinician);
  const groups = plan.order.map((key) => ({ key, label: GROUPS[key].label, items: GROUPS[key].items.filter(allowed) })).filter((g) => g.items.length > 0);
  const items = [...primary, ...groups.flatMap((g) => g.items)];
  // The most specific match wins (the price list sits under Finance).
  const current = items
    .map((n) => ({ n, length: Math.max(0, ...[n.href, ...(n.also ?? [])].filter((href) => isActive(pathname, href)).map((href) => href.length)) }))
    .filter((m) => m.length > 0)
    .sort((a, b) => b.length - a.length)[0]?.n;
  const title = current?.label ?? PAGE_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "Overview";
  const [open, setOpen] = useState(false);

  const stored = useSyncExternalStore(subscribeGroups, readGroups, () => "");
  const choices = useMemo(() => parseGroups(stored), [stored]);
  const isOpen = (key: GroupKey, holdsCurrent: boolean) => choices[key] ?? (holdsCurrent || plan.open.includes(key));
  function toggleGroup(key: GroupKey, next: boolean) {
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify({ ...choices, [key]: next }));
    } catch {
      // storage may be unavailable (private mode); the choice just won't persist
    }
    window.dispatchEvent(new Event(GROUPS_EVENT));
  }

  // When someone signs out (or in) in another tab, or the browser restores this
  // page from its back-forward cache after a sign-out, reload: the server then
  // shows the sign-in page, never the previous person's screens.
  useEffect(() => {
    const stop = onAuthChange(() => window.location.reload());
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => {
      stop();
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // "/" puts the cursor in the patient search, unless something is being typed.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!searchRef.current || searchRef.current.offsetParent === null) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const canSearch = can(role, "patients:read");

  const link = (item: NavItem) => {
    const active = item === current;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={() => setOpen(false)}
        className={cn(
          "flex min-h-11 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors lg:min-h-8",
          active ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(26,32,44,0.08)] ring-1 ring-border" : "text-foreground/75 hover:bg-card/60 hover:text-foreground",
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", active ? "text-accent" : "text-muted-foreground")} aria-hidden="true" />
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  const nav = (
    <nav className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3" aria-label="Main">
      <div className="space-y-0.5">{primary.map(link)}</div>
      {groups.map((group) => {
        const holdsCurrent = Boolean(current && group.items.includes(current));
        const expanded = isOpen(group.key, holdsCurrent);
        const id = `nav-group-${group.key}`;
        return (
          <div key={group.key} className="mt-4">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => toggleGroup(group.key, !expanded)}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground lg:min-h-7"
            >
              <span className="flex items-center gap-1.5">
                {group.label}
                {/* A closed group still says that the current page is inside it. */}
                {!expanded && holdsCurrent ? <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" /> : null}
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !expanded && "-rotate-90")} aria-hidden="true" />
            </button>
            {expanded ? (
              <div id={id} className="mt-0.5 space-y-0.5">
                {group.items.map(link)}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex h-14 min-w-0 shrink-0 items-center gap-2.5 px-5">
      {/* Tenant logo from branding, else the default in /public/logo.svg */}
      <img src={logoUrl || "/logo.svg"} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-md object-contain" />
      <div className="min-w-0 leading-tight">
        <p className="truncate font-display text-sm font-semibold tracking-tight">{productName}</p>
        <p className="truncate text-xs text-muted-foreground" title={tenantName}>
          {tenantName}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-sidebar lg:flex">
        {brand}
        {nav}
      </aside>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-charcoal-slate/40 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-xl focus:outline-none lg:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex shrink-0 items-center justify-between pr-2">
              {brand}
              <DialogPrimitive.Close className="rounded-md p-2.5 text-muted-foreground hover:bg-card/60" aria-label="Close navigation">
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
            {nav}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-background px-4 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <DialogPrimitive.Trigger asChild>
                <button className="-ml-1.5 rounded-md p-2.5 text-muted-foreground hover:bg-muted lg:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </button>
              </DialogPrimitive.Trigger>
              {/* The page says its own name below; the bar names it for assistive technology and the browser's outline. */}
              <h1 className="sr-only">{title}</h1>
              {/* Without the rail (a small screen) the bar carries the clinic's brand. */}
              <Link href="/dashboard" className="flex min-w-0 items-center gap-2 rounded-md lg:hidden">
                <img src={logoUrl || "/logo.svg"} alt="" width={24} height={24} className="h-6 w-6 shrink-0 rounded-md object-contain" />
                <span className="truncate font-display text-sm font-semibold tracking-tight">{productName}</span>
              </Link>
              {canSearch ? (
                <form
                  role="search"
                  action="/dashboard/patients"
                  method="get"
                  className="relative hidden w-full max-w-sm lg:block"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const q = searchRef.current?.value.trim() ?? "";
                    router.push(q ? `/dashboard/patients?q=${encodeURIComponent(q)}` : "/dashboard/patients");
                  }}
                >
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <input
                    ref={searchRef}
                    type="search"
                    name="q"
                    aria-label="Find a patient"
                    placeholder="Find a patient: name, phone or e-mail"
                    className="h-9 w-full rounded-lg border border-input bg-card pl-8 pr-9 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <kbd className="pointer-events-none absolute right-2 top-1/2 hidden h-5 -translate-y-1/2 items-center rounded border border-border bg-muted px-1.5 font-sans text-xs font-medium text-muted-foreground xl:inline-flex" aria-hidden="true">
                    /
                  </kbd>
                </form>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {canSearch ? (
                <Link href="/dashboard/patients" className="rounded-md p-2.5 text-muted-foreground hover:bg-muted lg:hidden" aria-label="Find a patient">
                  <Search className="h-5 w-5" />
                </Link>
              ) : null}
              <NotificationBell />
              <ThemeToggle />
              <UserMenu user={user} />
            </div>
          </header>
          <main className="flex-1 p-4 sm:p-6">{children}</main>
        </div>
      </DialogPrimitive.Root>
    </div>
  );
}
