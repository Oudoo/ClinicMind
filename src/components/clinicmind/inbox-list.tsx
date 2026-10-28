import Link from "next/link";
import { cn, initials } from "@/lib/utils";
import { EmptyState } from "@/components/ui/primitives";
import type { ConversationRowDTO } from "@/modules/messaging/dto";
import { ChannelBadge, OwnerChip, whenLabel } from "./lead-shared";
import { ConversationStatusBadge, inboxHref, type InboxState } from "./inbox-shared";

const OUTBOUND_PREFIX: Record<string, string> = { AI: "AI: ", HUMAN: "You: ", SYSTEM: "Auto: " };

/**
 * The thread list of the inbox: who, on which channel, the last line, how
 * long ago, who has it, and a dot while anything inbound is unread. Each row
 * selects the thread (`?c=<id>`) and keeps the filters.
 */
export function InboxList({
  rows,
  selectedId,
  state,
  timezone,
  now,
  filtered,
}: {
  rows: ConversationRowDTO[];
  selectedId: string | null;
  state: InboxState;
  timezone: string;
  now: Date;
  filtered: boolean;
}) {
  if (!rows.length) {
    return (
      <div className="p-4">
        <EmptyState title={filtered ? "No conversations match" : "Inbox zero"} hint={filtered ? "Try another queue, channel or search." : "New WhatsApp, web chat and SMS messages land here."} />
      </div>
    );
  }
  return (
    <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" aria-label="Conversations">
      {rows.map((row) => {
        const selected = row.id === selectedId;
        const last = row.lastMessage;
        const unread = row.unread > 0;
        return (
          <li key={row.id}>
            <Link
              href={inboxHref({ ...state, c: row.id })}
              scroll={false}
              aria-current={selected ? "true" : undefined}
              className={cn("flex gap-3 px-3 py-3 transition-colors hover:bg-muted/50 sm:px-4", selected && "bg-accent-muted/60 hover:bg-accent-muted/60")}
            >
              <span className="relative mt-0.5 shrink-0">
                <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-md bg-muted font-mono text-xs text-muted-foreground">
                  {initials(row.displayName.replace(/^\+/, "")) || "?"}
                </span>
                {unread ? <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-accent ring-2 ring-card" title={`${row.unread} unread`} /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>{row.displayName}</span>
                  <span className={cn("shrink-0 font-mono text-[11px]", unread ? "text-accent" : "text-muted-foreground")}>
                    {last ? whenLabel(last.createdAt, timezone, now) : whenLabel(row.updatedAt, timezone, now)}
                  </span>
                </span>
                <span className={cn("mt-0.5 block truncate text-xs", unread ? "text-foreground" : "text-muted-foreground")} dir="auto">
                  {last ? `${last.direction === "OUTBOUND" ? (OUTBOUND_PREFIX[last.author] ?? "") : ""}${last.body}` : "No messages yet"}
                </span>
                <span className="mt-1.5 flex flex-wrap items-center gap-1">
                  <ChannelBadge channel={row.channel} />
                  <ConversationStatusBadge status={row.status} />
                  {unread ? <span className="sr-only">{row.unread} unread</span> : null}
                  {row.assignedTo ? (
                    <span className="ml-auto">
                      <OwnerChip owner={row.assignedTo} />
                    </span>
                  ) : null}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
