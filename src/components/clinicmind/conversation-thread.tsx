"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, CheckCheck, Clock, FileText, Link2, MessageCircle, RotateCcw, Sparkles, UserPlus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { dateKeyInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { OBJECTION_LABELS, OBJECTION_TAGS, channelToSource, waMeLink, type ObjectionTagKey } from "@/modules/crm/shared";
import {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_LABELS,
  type ConversationStatusKey,
  type ConversationThreadDTO,
  type DeliveryKey,
  type MessageDTO,
  type TemplateDTO,
} from "@/modules/messaging/dto";
import { ConversationLinkDialog } from "./conversation-link-dialog";
import { ConversationReply } from "./conversation-reply";
import { ConversationStatusBadge, DELIVERY_SHORT, authorLabel, deliveryTitle } from "./inbox-shared";
import { EMPTY_LEAD, LeadFormDialog, type LeadFormOptions } from "./lead-new-dialog";
import { ChannelBadge, StageBadge, clinicDate, clinicTime, crmErrorMessage, whenLabel, type StaffOption } from "./lead-shared";

/**
 * One thread of the reception inbox: who it is (patient or lead, number with
 * a wa.me link), the actions (assign, status, link, create a lead, close),
 * the objection tags the AI suggested for staff to confirm, the messages with
 * author, time and delivery, and the reply box. Opening it marks the
 * patient's messages read.
 */
export function ConversationThread({
  conversation,
  templates,
  staff,
  leadOptions,
  canWrite,
  timezone,
  nowIso,
  backHref,
}: {
  conversation: ConversationThreadDTO;
  templates: TemplateDTO[];
  staff: StaffOption[];
  leadOptions: LeadFormOptions;
  canWrite: boolean;
  timezone: string;
  nowIso: string;
  backHref: string;
}) {
  const router = useRouter();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const scroller = useRef<HTMLDivElement>(null);
  const marked = useRef<string | null>(null);
  const wa = waMeLink(conversation.contactPhone);
  const lastId = conversation.messages[conversation.messages.length - 1]?.id;
  const newestUnread = [...conversation.messages].reverse().find((m) => m.direction === "INBOUND" && !m.readAt)?.id ?? null;

  // Opening the thread reads it: the patient's unread messages are stamped once per new arrival.
  useEffect(() => {
    if (!newestUnread || marked.current === newestUnread) return;
    marked.current = newestUnread;
    apiFetch(`/api/conversations/${conversation.id}/read`, { method: "POST" })
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [conversation.id, newestUnread, router]);

  // The newest message in view when a thread opens or a message arrives.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.id, lastId]);

  const days = useMemo(() => {
    const out: { key: string; label: string; messages: MessageDTO[] }[] = [];
    for (const m of conversation.messages) {
      const at = new Date(m.createdAt);
      const key = dateKeyInTz(at, timezone);
      if (out[out.length - 1]?.key !== key) out.push({ key, label: whenLabel(at, timezone, now, { withTime: false }), messages: [] });
      out[out.length - 1]!.messages.push(m);
    }
    return out;
  }, [conversation.messages, timezone, now]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="space-y-3 border-b border-border p-3 sm:p-4">
        <div className="flex items-start gap-2">
          <Button asChild variant="ghost" size="icon" className="-ml-1 shrink-0 lg:hidden">
            <Link href={backHref} aria-label="Back to the conversations" scroll={false}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate font-display text-base font-semibold tracking-tight">{conversation.displayName}</h3>
              <ChannelBadge channel={conversation.channel} />
              <ConversationStatusBadge status={conversation.status} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {conversation.contactPhone ? (
                <span className="inline-flex items-center gap-1.5 font-mono">
                  {conversation.contactPhone}
                  {wa ? (
                    <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-sans text-success hover:underline" title="Open a WhatsApp chat (wa.me)">
                      <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                      WhatsApp ↗
                    </a>
                  ) : null}
                </span>
              ) : null}
              {conversation.patient ? (
                <Link href={`/dashboard/patients/${conversation.patient.id}`} className="hover:text-foreground hover:underline">
                  Patient: {conversation.patient.fullName}
                </Link>
              ) : null}
              {conversation.lead ? (
                <Link href={`/dashboard/leads/${conversation.lead.id}`} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                  Lead: {conversation.lead.fullName} <StageBadge stage={conversation.lead.stage} />
                </Link>
              ) : null}
              {!conversation.patient && !conversation.lead ? <span>Not linked to a patient or a lead</span> : null}
            </div>
            {conversation.summary ? (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
                <span>{conversation.summary}</span>
              </p>
            ) : null}
          </div>
        </div>
        {canWrite ? <ThreadActions conversation={conversation} staff={staff} leadOptions={leadOptions} /> : null}
        <ObjectionTagger key={`${conversation.id}:${conversation.objections.join(",")}:${conversation.objectionsConfirmedAt ?? ""}`} conversation={conversation} canWrite={canWrite} timezone={timezone} now={now} />
      </header>

      <div ref={scroller} className="max-h-[60vh] min-h-[12rem] flex-1 space-y-3 overflow-y-auto bg-muted/30 p-3 sm:p-4 lg:max-h-none" aria-label="Messages">
        {conversation.truncated ? <p className="text-center text-xs text-muted-foreground">Showing the latest {conversation.messages.length} messages.</p> : null}
        {!conversation.messages.length ? <p className="py-8 text-center text-sm text-muted-foreground">No messages in this thread yet.</p> : null}
        {days.map((day) => (
          <Fragment key={day.key}>
            <div className="flex justify-center">
              <span className="rounded-full bg-card px-3 py-0.5 font-mono text-[11px] text-muted-foreground shadow-sm">{day.label}</span>
            </div>
            {day.messages.map((m) => (
              <MessageBubble key={m.id} message={m} timezone={timezone} />
            ))}
          </Fragment>
        ))}
      </div>

      {canWrite ? <ConversationReply conversation={conversation} templates={templates} now={now} /> : <p className="border-t border-border p-3 text-center text-xs text-muted-foreground">Your role can read conversations but not reply.</p>}
    </div>
  );
}

const DELIVERY_ICON: Record<DeliveryKey, typeof Check> = {
  QUEUED: Clock,
  SENT: Check,
  DELIVERED: CheckCheck,
  READ: CheckCheck,
  FAILED: AlertTriangle,
  LOGGED: FileText,
};

function MessageBubble({ message: m, timezone }: { message: MessageDTO; timezone: string }) {
  const out = m.direction === "OUTBOUND";
  const Icon = DELIVERY_ICON[m.delivery];
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div className="max-w-[88%] space-y-1 sm:max-w-[75%]">
        <div
          dir="auto"
          className={cn(
            "whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed",
            !out && "rounded-tl-sm border border-border bg-card",
            out && m.author === "HUMAN" && "rounded-tr-sm bg-accent text-accent-foreground",
            out && m.author === "AI" && "rounded-tr-sm border border-accent/20 bg-accent-muted",
            out && m.author === "SYSTEM" && "rounded-tr-sm border border-dashed border-border bg-card",
          )}
        >
          {m.body}
        </div>
        <p className={cn("flex flex-wrap items-center gap-x-1.5 font-mono text-[10px] text-muted-foreground", out && "justify-end")}>
          <span className={cn(m.author === "AI" && "text-accent")}>{authorLabel(m.author, m.authorName)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={m.createdAt} title={`${clinicDate(new Date(m.createdAt), timezone, { weekday: true, year: true })} ${clinicTime(new Date(m.createdAt), timezone)}`}>
            {clinicTime(new Date(m.createdAt), timezone)}
          </time>
          {out ? (
            <span title={deliveryTitle(m.delivery, m.failedReason)} className={cn("inline-flex items-center gap-0.5", m.delivery === "FAILED" && "text-danger", m.delivery === "READ" && "text-accent")}>
              <span aria-hidden="true">·</span>
              <Icon className="h-3 w-3" aria-hidden="true" />
              {DELIVERY_SHORT[m.delivery]}
            </span>
          ) : !m.readAt ? (
            <Badge tone="accent" className="px-1 py-0 text-[9px]">
              new
            </Badge>
          ) : null}
          {m.templateKey && !m.templateKey.startsWith("concierge:") ? <span>· template</span> : null}
        </p>
        {m.delivery === "FAILED" && m.failedReason ? <p className={cn("text-[11px] text-danger", out && "text-right")}>{m.failedReason}</p> : null}
      </div>
    </div>
  );
}

function ThreadActions({ conversation, staff, leadOptions }: { conversation: ConversationThreadDTO; staff: StaffOption[]; leadOptions: LeadFormOptions }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | "link" | "lead">(null);
  const closed = conversation.status === "CLOSED";

  async function patch(body: Record<string, unknown>, message: string) {
    setBusy(true);
    try {
      await apiFetch(`/api/conversations/${conversation.id}`, { method: "PATCH", body });
      toast({ title: message, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not update the conversation", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  const looksLikeName = conversation.contactName && !/^\+?\d[\d\s]+$/.test(conversation.contactName);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${id}-assign`} className="sr-only">
        Assign to
      </label>
      <Select
        id={`${id}-assign`}
        value={conversation.assignedTo?.id ?? ""}
        disabled={busy}
        onChange={(e) => {
          const person = staff.find((s) => s.id === e.target.value);
          void patch({ assignedToId: e.target.value || null }, person ? `Assigned to ${person.fullName}` : "Unassigned");
        }}
        className="h-8 w-auto min-w-0 max-w-[11rem] text-xs"
      >
        <option value="">Unassigned</option>
        {staff.map((s) => (
          <option key={s.id} value={s.id}>
            {s.fullName}
          </option>
        ))}
      </Select>
      <label htmlFor={`${id}-status`} className="sr-only">
        Status
      </label>
      <Select
        id={`${id}-status`}
        value={conversation.status}
        disabled={busy}
        onChange={(e) => void patch({ status: e.target.value }, `Marked “${CONVERSATION_STATUS_LABELS[e.target.value as ConversationStatusKey]}”`)}
        className="h-8 w-auto min-w-0 max-w-[11rem] text-xs"
      >
        {CONVERSATION_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CONVERSATION_STATUS_LABELS[s]}
          </option>
        ))}
      </Select>
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog("link")}>
        <Link2 className="h-4 w-4" />
        Link
      </Button>
      {!conversation.lead && !conversation.patient ? (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setDialog("lead")}>
          <UserPlus className="h-4 w-4" />
          Create lead
        </Button>
      ) : null}
      <Button type="button" variant={closed ? "outline" : "ghost"} size="sm" disabled={busy} onClick={() => void patch({ status: closed ? "OPEN" : "CLOSED" }, closed ? "Conversation reopened" : "Conversation closed")}>
        {closed ? <RotateCcw className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
        {closed ? "Reopen" : "Close"}
      </Button>
      {dialog === "link" ? (
        <ConversationLinkDialog
          conversation={conversation}
          onOpenChange={(open) => !open && setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
      {dialog === "lead" ? (
        <LeadFormDialog
          mode="create"
          title="Create a lead from this conversation"
          conversationId={conversation.id}
          initial={{ ...EMPTY_LEAD, fullName: looksLikeName ? conversation.contactName! : "", phone: conversation.contactPhone ?? "", source: channelToSource(conversation.channel), ownerId: conversation.assignedTo?.id ?? "" }}
          options={leadOptions}
          onOpenChange={(open) => !open && setDialog(null)}
          onDone={() => {
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Objection tags: the AI's suggestions (or the keyword tagger's) are
 * pre-ticked; staff adjust them and confirm, which copies them to the lead.
 */
function ObjectionTagger({ conversation, canWrite, timezone, now }: { conversation: ConversationThreadDTO; canWrite: boolean; timezone: string; now: Date }) {
  const router = useRouter();
  const { toast } = useToast();
  const confirmedAt = conversation.objectionsConfirmedAt;
  const suggested: ObjectionTagKey[] = confirmedAt ? [] : conversation.objections;
  const [selected, setSelected] = useState<ObjectionTagKey[]>(conversation.objections);
  const [busy, setBusy] = useState(false);
  const changed = selected.length !== conversation.objections.length || selected.some((t) => !conversation.objections.includes(t));

  if (!canWrite && !conversation.objections.length) return null;

  async function confirm() {
    setBusy(true);
    try {
      await apiFetch(`/api/conversations/${conversation.id}`, { method: "PATCH", body: { objections: selected } });
      toast({ title: selected.length ? "Objections confirmed" : "No objections confirmed", description: conversation.lead ? "Copied to the lead." : undefined, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not save the objections", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="data-label">Objections</span>
        {confirmedAt ? (
          <span>confirmed {whenLabel(confirmedAt, timezone, now)}</span>
        ) : suggested.length ? (
          <span className="inline-flex items-center gap-1">
            <Sparkles className="h-3 w-3 text-accent" aria-hidden="true" />
            suggested from the messages{canWrite ? ": tick what the patient really raised, then confirm" : ""}
          </span>
        ) : (
          <span>none suggested</span>
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {OBJECTION_TAGS.filter((t) => canWrite || selected.includes(t)).map((tag) => {
          const on = selected.includes(tag);
          const ai = suggested.includes(tag);
          return canWrite ? (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              disabled={busy}
              onClick={() => setSelected((xs) => (on ? xs.filter((x) => x !== tag) : [...xs, tag]))}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors",
                on ? "border-warning/50 bg-warning/10 text-warning" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {on ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
              {OBJECTION_LABELS[tag]}
              {ai ? <span className="font-mono text-[9px] uppercase text-accent">AI</span> : null}
            </button>
          ) : (
            <Badge key={tag} tone="warning">
              {OBJECTION_LABELS[tag]}
            </Badge>
          );
        })}
        {canWrite && (changed || (!confirmedAt && conversation.objections.length > 0)) ? (
          <Button type="button" size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Saving…" : "Confirm tags"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
