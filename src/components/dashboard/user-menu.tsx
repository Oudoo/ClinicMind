"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { ChevronDown, LogOut, Settings, UserRound } from "lucide-react";
import Link from "next/link";
import { announceAuthChange, clearBrowserState } from "@/lib/auth/browser-session";
import { initials } from "@/lib/utils";

export interface ShellUser {
  email: string | null;
  fullName: string | null;
  role: string;
  /** False for embed-token sessions, which have nothing to sign out of here. */
  canSignOut: boolean;
}

export function UserMenu({ user }: { user: ShellUser }) {
  const [pending, setPending] = useState(false);
  const name = user.fullName ?? user.email ?? "Embedded session";

  /**
   * Sign out, then load the sign-in page as a new document: a client-side
   * navigation would keep this person's screens (assistant chat, unsaved
   * edits, the router's page cache) in memory for whoever uses the browser next.
   */
  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } catch {
      // Offline: the page is still wiped below; the session ends when it expires or on the next sign-out.
    } finally {
      clearBrowserState();
      announceAuthChange("signed-out");
      window.location.replace("/login");
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Account menu"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent-muted font-mono text-xs text-accent">
            {user.fullName ? initials(user.fullName) : <UserRound className="h-4 w-4" />}
          </span>
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="max-w-[12rem] truncate text-xs font-medium">{name}</span>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">{user.role.replace("_", " ")}</span>
          </span>
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground sm:block" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[14rem] rounded-lg border border-border bg-card p-1 shadow-lg animate-fade-in"
        >
          <div className="px-2 py-2">
            <p className="truncate text-sm font-medium">{name}</p>
            {user.email && user.fullName ? (
              <p className="truncate font-mono text-xs text-muted-foreground">{user.email}</p>
            ) : null}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link
              href="/dashboard/settings"
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus:bg-muted"
            >
              <Settings className="h-4 w-4" /> Settings
            </Link>
          </DropdownMenu.Item>
          {user.canSignOut ? (
            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                void signOut();
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-danger outline-none hover:bg-danger/5 focus:bg-danger/5"
            >
              <LogOut className="h-4 w-4" /> {pending ? "Signing out…" : "Sign out"}
            </DropdownMenu.Item>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
