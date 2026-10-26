"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, CheckCheck, Inbox } from "lucide-react";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import {
  emitNotificationsChanged,
  NOTIFICATIONS_CHANGED_EVENT,
  NotificationBody,
  PREFERENCES_CHANGED_EVENT,
} from "@/components/clinicmind/notification-shared";
import { KIND_LABELS, safeNotificationHref, type NotificationDTO } from "@/modules/notifications/kinds";

/**
 * The bell in the dashboard header: unread count, the latest notifications and
 * "mark all read". Owned by the notifications module; the shell only places it.
 *
 * Polls GET /api/notifications?unread=1&since=… every 30 s and whenever the tab
 * regains focus. New unread rows since the previous poll become a desktop
 * notification when the user's `browser` preference is on and permission was
 * granted; CRITICAL ones also raise a toast regardless. Renders nothing on the
 * platform console, where there is no clinic to be notified about.
 */
const POLL_MS = 30_000;
const DROPDOWN_TAKE = 8;
/** At most this many desktop notifications per poll; the rest are summarised in one. */
const MAX_DESKTOP_PER_POLL = 3;

interface ListResponse {
  notifications: NotificationDTO[];
  unread: number;
  now: string;
}

interface PreferencesResponse {
  preferences: { browser: boolean };
}

export function NotificationBell() {
  const pathname = usePathname() ?? "";
  const quiet = pathname.startsWith("/platform");
  const router = useRouter();
  const { toast } = useToast();

  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationDTO[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const sinceRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const browserPrefRef = useRef(false);
  const openRef = useRef(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const loadLatest = useCallback(async () => {
    try {
      const res = await apiFetch<ListResponse>(`/api/notifications?take=${DROPDOWN_TAKE}`);
      setItems(res.notifications);
      setUnread(res.unread);
      setNow(new Date(res.now));
    } catch {
      setItems((prev) => prev ?? []);
    }
  }, []);

  const openNotification = useCallback(
    async (n: NotificationDTO) => {
      const href = safeNotificationHref(n.href);
      if (!n.readAt) {
        setItems((prev) => prev?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? prev);
        setUnread((u) => Math.max(0, u - 1));
        apiFetch("/api/notifications/read", { method: "POST", body: { ids: [n.id] } })
          .then(() => emitNotificationsChanged("bell"))
          .catch(() => undefined);
      }
      setOpen(false);
      if (href) router.push(href);
    },
    [router],
  );

  const announce = useCallback(
    (fresh: NotificationDTO[]) => {
      for (const n of fresh) {
        if (n.level === "CRITICAL") {
          toast({ title: n.title, description: n.body ?? KIND_LABELS[n.kind], tone: "danger", durationMs: 10_000 });
        }
      }
      if (!browserPrefRef.current) return;
      if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") return;
      const shown = fresh.slice(0, MAX_DESKTOP_PER_POLL);
      const rest = fresh.length - shown.length;
      const raise = (title: string, body: string, tag: string, target: NotificationDTO | null) => {
        try {
          const note = new Notification(title, { body, tag, icon: "/logo.svg" });
          note.onclick = () => {
            window.focus();
            note.close();
            if (target) void openNotification(target);
            else router.push("/dashboard/notifications");
          };
        } catch {
          // Some browsers only allow notifications from a service worker; the bell still shows them.
        }
      };
      for (const n of shown) raise(n.title, n.body?.split("\n")[0] ?? KIND_LABELS[n.kind], n.id, n);
      if (rest > 0) raise(`${rest} more notification${rest === 1 ? "" : "s"}`, "Open the bell to see them all.", "clinicmind-more", null);
    },
    [openNotification, router, toast],
  );

  /** The poll: total unread plus the unread rows created since the last poll. */
  const poll = useCallback(
    async (opts: { announce: boolean }) => {
      try {
        const qs = new URLSearchParams({ unread: "1", take: String(DROPDOWN_TAKE) });
        if (sinceRef.current) qs.set("since", sinceRef.current);
        const res = await apiFetch<ListResponse>(`/api/notifications?${qs.toString()}`);
        setUnread(res.unread);
        setNow(new Date(res.now));
        const fresh = res.notifications.filter((n) => !seenRef.current.has(n.id));
        for (const n of res.notifications) seenRef.current.add(n.id);
        const newest = res.notifications[0]?.createdAt;
        if (newest && (!sinceRef.current || newest > sinceRef.current)) sinceRef.current = newest;
        else if (!sinceRef.current) sinceRef.current = res.now;
        if (!opts.announce) {
          // First poll: seed the dropdown with what is unread right now.
          setItems((prev) => prev ?? res.notifications);
          return;
        }
        if (fresh.length) {
          announce(fresh);
          if (openRef.current) void loadLatest();
          else setItems((prev) => (prev ? [...fresh, ...prev.filter((p) => !fresh.some((f) => f.id === p.id))].slice(0, DROPDOWN_TAKE) : prev));
        }
      } catch {
        // A failed poll is silent: the bell never nags about itself.
      }
    },
    [announce, loadLatest],
  );

  useEffect(() => {
    if (quiet) return;
    let cancelled = false;
    // First poll on the next tick: the effect only subscribes, the poll updates state later.
    const initial = window.setTimeout(() => {
      void poll({ announce: false });
      apiFetch<PreferencesResponse>("/api/notifications/preferences")
        .then((res) => {
          if (!cancelled) browserPrefRef.current = Boolean(res.preferences.browser);
        })
        .catch(() => undefined);
    }, 0);

    const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
    const timer = window.setInterval(() => {
      if (visible()) void poll({ announce: true });
    }, POLL_MS);
    const onFocus = () => {
      if (visible()) void poll({ announce: true });
    };
    const onChanged = (e: Event) => {
      const source = (e as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "bell") return;
      void poll({ announce: true });
      if (openRef.current) void loadLatest();
      else setItems(null);
    };
    const onPrefs = (e: Event) => {
      const detail = (e as CustomEvent<{ browser?: boolean }>).detail;
      if (typeof detail?.browser === "boolean") browserPrefRef.current = detail.browser;
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onPrefs);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
      window.removeEventListener(PREFERENCES_CHANGED_EVENT, onPrefs);
    };
  }, [quiet, poll, loadLatest]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) void loadLatest();
  }

  async function markAllRead() {
    if (busy || !unread) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ updated: number; unread: number }>("/api/notifications/read", { method: "POST", body: { all: true } });
      const at = new Date().toISOString();
      setItems((prev) => prev?.map((x) => (x.readAt ? x : { ...x, readAt: at })) ?? prev);
      setUnread(res.unread);
      emitNotificationsChanged("bell");
    } catch (err) {
      toast({ title: "Could not mark notifications as read", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  if (quiet) return null;

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
          data-testid="notification-bell"
        >
          <Bell className="h-4 w-4" />
          {unread > 0 ? (
            <span
              data-testid="notification-badge"
              className="absolute -right-0.5 -top-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-danger px-1 font-mono text-[10px] font-medium leading-none text-white"
            >
              {badge}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[min(24rem,calc(100vw-1rem))] overflow-hidden rounded-lg border border-border bg-card shadow-lg animate-fade-in"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <p className="text-sm font-medium">
              Notifications
              {unread ? <span className="ml-2 font-mono text-xs text-muted-foreground">{unread} unread</span> : null}
            </p>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={busy || !unread}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          </div>

          <div className="max-h-[min(70vh,28rem)] overflow-y-auto" data-testid="notification-dropdown">
            {items === null ? (
              <div className="space-y-3 p-3" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
                <Inbox className="h-5 w-5 text-muted-foreground" />
                <p className="text-sm font-medium">You are all caught up</p>
                <p className="text-xs text-muted-foreground">New bookings, escalations and alerts will appear here.</p>
              </div>
            ) : (
              items.map((n) => (
                <DropdownMenu.Item
                  key={n.id}
                  onSelect={() => void openNotification(n)}
                  className={cn(
                    "flex cursor-pointer gap-3 border-b border-border px-3 py-2.5 outline-none last:border-0 data-[highlighted]:bg-muted",
                    !n.readAt && "bg-accent-muted/40",
                  )}
                >
                  <NotificationBody n={n} now={now} compact />
                </DropdownMenu.Item>
              ))
            )}
          </div>

          <DropdownMenu.Item asChild>
            <Link
              href="/dashboard/notifications"
              className="flex cursor-pointer items-center justify-center gap-1 border-t border-border px-3 py-2 text-xs font-medium text-accent outline-none hover:bg-muted focus:bg-muted"
            >
              See all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
