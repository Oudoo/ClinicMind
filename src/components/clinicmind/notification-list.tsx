"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Check, CheckCheck, ExternalLink, Inbox, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { KIND_LABELS, NOTIFICATION_KINDS, safeNotificationHref, type NotificationDTO } from "@/modules/notifications/kinds";
import type { NotificationKind } from "@prisma/client";
import {
  emitNotificationsChanged,
  groupByDay,
  NOTIFICATIONS_CHANGED_EVENT,
  NotificationBody,
} from "./notification-shared";

/**
 * The /dashboard/notifications list: the first page comes from the server,
 * "load more" pages backwards through the API by creation time, filters are
 * URL state (unread/all, kind) so a filtered view can be bookmarked, and every
 * row can be opened or marked read on its own.
 */
export type ListFilter = "unread" | "all";

interface ListResponse {
  notifications: NotificationDTO[];
  unread: number;
  now: string;
}

export function listHref(filter: ListFilter, kind?: NotificationKind | null): string {
  const params = new URLSearchParams();
  if (filter === "all") params.set("filter", "all");
  if (kind) params.set("kind", kind);
  const qs = params.toString();
  return qs ? `/dashboard/notifications?${qs}` : "/dashboard/notifications";
}

export function NotificationList({
  initial,
  filter,
  kind,
  take,
  timezone,
  unread: initialUnread,
}: {
  initial: NotificationDTO[];
  filter: ListFilter;
  kind: NotificationKind | null;
  take: number;
  timezone: string;
  unread: number;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [items, setItems] = useState<NotificationDTO[]>(initial);
  const [unread, setUnread] = useState(initialUnread);
  const [hasMore, setHasMore] = useState(initial.length >= take);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | "all" | null>(null);
  const [now, setNow] = useState(() => new Date());

  const query = useCallback(
    (extra: Record<string, string>) => {
      const params = new URLSearchParams({ take: String(take), ...extra });
      if (filter === "unread") params.set("unread", "1");
      if (kind) params.set("kind", kind);
      return `/api/notifications?${params.toString()}`;
    },
    [filter, kind, take],
  );

  /** Reload the first page (after another surface, e.g. the bell, changed something). */
  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<ListResponse>(query({}));
      setItems(res.notifications);
      setUnread(res.unread);
      setHasMore(res.notifications.length >= take);
      setNow(new Date(res.now));
    } catch {
      // keep what we have
    }
  }, [query, take]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const source = (e as CustomEvent<{ source?: string }>).detail?.source;
      if (source === "list") return;
      void refresh();
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  async function loadMore() {
    const last = items[items.length - 1];
    if (!last || loading) return;
    setLoading(true);
    try {
      const res = await apiFetch<ListResponse>(query({ before: last.createdAt }));
      setItems((prev) => {
        const known = new Set(prev.map((p) => p.id));
        return [...prev, ...res.notifications.filter((n) => !known.has(n.id))];
      });
      setUnread(res.unread);
      setHasMore(res.notifications.length >= take);
      setNow(new Date(res.now));
    } catch (err) {
      toast({ title: "Could not load more notifications", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setLoading(false);
    }
  }

  async function markOne(n: NotificationDTO, navigateTo?: string | null) {
    if (n.readAt) {
      if (navigateTo) router.push(navigateTo);
      return;
    }
    setBusy(n.id);
    const at = new Date().toISOString();
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: at } : x)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      const res = await apiFetch<{ updated: number; unread: number }>("/api/notifications/read", { method: "POST", body: { ids: [n.id] } });
      setUnread(res.unread);
      emitNotificationsChanged("list");
      if (filter === "unread" && !navigateTo) {
        // Let the reader see the tick before the row leaves the unread view.
        window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== n.id)), 600);
      }
    } catch (err) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: null } : x)));
      setUnread((u) => u + 1);
      toast({ title: "Could not mark as read", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setBusy(null);
      if (navigateTo) router.push(navigateTo);
    }
  }

  async function markAll() {
    if (busy || !unread) return;
    setBusy("all");
    try {
      const res = await apiFetch<{ updated: number; unread: number }>("/api/notifications/read", { method: "POST", body: { all: true } });
      const at = new Date().toISOString();
      setItems((prev) => (filter === "unread" ? [] : prev.map((x) => (x.readAt ? x : { ...x, readAt: at }))));
      setUnread(res.unread);
      if (filter === "unread") setHasMore(false);
      emitNotificationsChanged("list");
      toast({ title: res.updated ? `${res.updated} marked as read` : "Nothing was unread", tone: "success" });
    } catch (err) {
      toast({ title: "Could not mark all as read", description: err instanceof Error ? err.message : undefined, tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const groups = groupByDay(items, timezone, now);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Read state">
            {(["unread", "all"] as const).map((f) => (
              <Link
                key={f}
                role="tab"
                aria-selected={filter === f}
                href={listHref(f, kind)}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors",
                  filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "unread" ? `Unread${unread ? ` · ${unread}` : ""}` : "All"}
              </Link>
            ))}
          </div>
          <label className="sr-only" htmlFor="notifications-kind">
            Kind
          </label>
          <Select
            id="notifications-kind"
            value={kind ?? ""}
            onChange={(e) => router.push(listHref(filter, (e.target.value || null) as NotificationKind | null))}
            className="h-9 w-auto min-w-[12rem] text-sm"
          >
            <option value="">All kinds</option>
            {NOTIFICATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => void markAll()} disabled={busy !== null || !unread}>
          <CheckCheck className="h-4 w-4" /> Mark all read
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-4 py-12 text-center">
          <Inbox className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">{filter === "unread" ? "Nothing unread" : "No notifications yet"}</p>
          <p className="text-xs text-muted-foreground">
            {filter === "unread"
              ? kind
                ? `No unread ${KIND_LABELS[kind].toLowerCase()} notifications. Switch to All to see the history.`
                : "You are all caught up. Switch to All to see the history."
              : "Bookings, escalations, alerts and messages land here as they happen."}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="data-label mb-2">{group.label}</h3>
              <ul className="divide-y divide-border rounded-lg border border-border bg-card">
                {group.items.map((n) => {
                  const href = safeNotificationHref(n.href);
                  return (
                    <li
                      key={n.id}
                      className={cn("flex gap-3 px-3 py-3 sm:px-4", !n.readAt && "bg-accent-muted/30")}
                      data-testid="notification-row"
                      data-unread={n.readAt ? undefined : "true"}
                    >
                      <NotificationBody n={n} now={now} timezone={timezone} />
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {href ? (
                          <button
                            type="button"
                            onClick={() => void markOne(n, href)}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-muted"
                          >
                            Open <ExternalLink className="h-3 w-3" />
                          </button>
                        ) : null}
                        {!n.readAt ? (
                          <button
                            type="button"
                            onClick={() => void markOne(n)}
                            disabled={busy === n.id}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                            aria-label={`Mark "${n.title}" as read`}
                          >
                            <Check className="h-3 w-3" /> <span className="hidden sm:inline">Mark read</span>
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {hasMore ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void loadMore()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : (
            <p className="text-center font-mono text-[11px] text-muted-foreground">
              {items.length} shown · read notifications are kept for 90 days
            </p>
          )}
        </div>
      )}
    </div>
  );
}
