import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { MessagesSquare } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { cn } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import { listCampaignRefs, listTenantStaff } from "@/modules/crm/service";
import { ConversationListQuery, getConversation, listConversations, type ConversationListFilter } from "@/modules/messaging/service";
import { listTemplates } from "@/modules/messaging/templates";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { InboxAutoRefresh, InboxFilters } from "@/components/clinicmind/inbox-filters";
import { InboxList } from "@/components/clinicmind/inbox-list";
import { ConversationThread } from "@/components/clinicmind/conversation-thread";
import { inboxHref, type InboxState } from "@/components/clinicmind/inbox-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(sp: SearchParams, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/** The list filters from the URL; a value the API would refuse is dropped instead of failing the page. */
function parseInboxQuery(sp: SearchParams): { filter: ConversationListFilter; state: InboxState } {
  const raw: Record<string, string> = {};
  for (const key of ["status", "channel", "mine", "q", "page"]) {
    const v = firstValue(sp, key)?.trim();
    if (v) raw[key] = v.slice(0, 100);
  }
  let parsed = ConversationListQuery.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) delete raw[String(issue.path[0])];
    parsed = ConversationListQuery.safeParse(raw);
  }
  const filter = parsed.success ? parsed.data : ConversationListQuery.parse({});
  return {
    filter,
    state: { status: filter.status, channel: filter.channel, mine: filter.mine === "1" ? "1" : undefined, q: filter.q, page: filter.page },
  };
}

/**
 * `/dashboard/conversations?status=&channel=&mine=1&q=&c=<id>` — the reception
 * inbox. Two panes on a desktop (threads | the selected thread), two screens
 * on a phone (`?c=` opens the thread, Back returns to the list).
 * conversations:read to read, conversations:write to act.
 */
export default async function ConversationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  if (!can(ctx.role, "conversations:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Conversations · reception inbox" />
        <Card>
          <EmptyState title="The inbox is not available for your role" />
        </Card>
      </div>
    );
  }

  const { filter, state } = parseInboxQuery(sp);
  const selectedId = firstValue(sp, "c")?.trim().slice(0, 64) || null;
  const canWrite = can(ctx.role, "conversations:write");
  const now = new Date();

  const [list, thread, timezone] = await Promise.all([
    listConversations(ctx.tenantId, filter, ctx.userId),
    selectedId ? getConversation(ctx.tenantId, selectedId) : Promise.resolve(null),
    getTenantTimezone(ctx.tenantId),
  ]);
  const [templates, staff, treatments, campaigns] =
    thread && canWrite
      ? await Promise.all([listTemplates(ctx.tenantId), listTenantStaff(ctx.tenantId), listTreatments(ctx.tenantId), listCampaignRefs(ctx.tenantId)])
      : [[], [], [], []];
  const assignable = staff.filter((s) => can(s.role as UserRole, "conversations:write"));
  const filtered = Boolean(filter.channel || filter.mine || filter.q || filter.status !== "open");
  const counts = list.counts;
  const backHref = inboxHref({ ...state, c: undefined });

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Conversations · reception inbox"
        description="WhatsApp, web chat and SMS in one place: reply, assign, confirm objections and turn enquiries into leads."
        action={
          <div className="hidden flex-wrap justify-end gap-1.5 sm:flex">
            <Badge tone={counts.unread ? "accent" : "default"}>{counts.unread} unread</Badge>
            <Badge tone={counts.waitingClinic ? "warning" : "default"}>{counts.waitingClinic} waiting on us</Badge>
          </div>
        }
      />
      <InboxAutoRefresh />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <Card className={cn("flex min-w-0 flex-col overflow-hidden p-0 lg:h-[calc(100dvh-11rem)] lg:min-h-[30rem]", selectedId ? "hidden lg:flex" : "flex")}>
          <InboxFilters state={state} counts={counts} />
          <InboxList rows={list.conversations} selectedId={selectedId} state={state} timezone={timezone} now={now} filtered={filtered} />
          {list.total > list.pageSize ? (
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={list.total}
              basePath="/dashboard/conversations"
              query={Object.fromEntries(Object.entries({ status: state.status === "open" ? undefined : state.status, channel: state.channel, mine: state.mine, q: state.q }).filter(([, v]) => v)) as Record<string, string>}
              className="border-t border-border px-3"
            />
          ) : null}
        </Card>
        <Card className={cn("flex min-w-0 flex-col overflow-hidden p-0 lg:h-[calc(100dvh-11rem)] lg:min-h-[30rem]", selectedId ? "flex" : "hidden lg:flex")}>
          {thread ? (
            <ConversationThread
              key={thread.id}
              conversation={thread}
              templates={templates}
              staff={assignable}
              leadOptions={{ treatments: treatments.map((t) => ({ key: t.key, name: t.name })), staff, campaigns }}
              canWrite={canWrite}
              timezone={timezone}
              nowIso={now.toISOString()}
              backHref={backHref}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <MessagesSquare className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">{selectedId ? "This conversation does not exist" : "Pick a conversation"}</p>
              <p className="text-xs text-muted-foreground">{selectedId ? "It may belong to another clinic, or the link is old." : "Threads waiting on the clinic come first in “Waiting on clinic”."}</p>
              {selectedId ? (
                <Link href={backHref} className="text-xs text-accent hover:underline">
                  Back to the inbox
                </Link>
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
