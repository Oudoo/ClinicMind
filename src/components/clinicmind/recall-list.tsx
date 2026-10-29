"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, MessageCircle, NotebookPen, Phone, Repeat2 } from "lucide-react";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/http";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, OWNER_ROLE_LABEL } from "@/modules/recalls/constants";
import type { RecallActivityDTO, RecallDetailDTO, RecallDTO } from "@/modules/recalls/dto";
import { RecallActions } from "./recall-actions";
import { BandBadge, egp, phoneOf, recallErrorMessage } from "./recall-shared";

const ACTIVITY_ICON = { CALL: Phone, MESSAGE: MessageCircle, STATUS: Repeat2, NOTE: NotebookPen } as const;

function when(iso: string, timezone: string): string {
  const d = new Date(iso);
  return `${formatDateInTz(d, timezone, { day: "numeric", month: "short" })} ${formatTimeInTz(d, timezone)}`;
}

function lastLine(r: RecallDTO, timezone: string): string | null {
  const a = r.lastActivity;
  if (!a) return null;
  const what = a.kind === "CALL" ? `Call: ${a.outcomeLabel ?? "logged"}` : a.kind === "MESSAGE" ? `WhatsApp: ${a.outcomeLabel ?? "sent"}` : a.kind === "NOTE" ? "Note" : (a.outcomeLabel ?? "Changed");
  return `${what} · ${a.by?.name ?? "automatically"} · ${when(a.at, timezone)}`;
}

/**
 * The worklist: one card per recall with who, what for, how urgent, where it
 * stands, what it is worth and the actions; "Log" opens everything done on it.
 */
export function RecallList({ recalls, timezone, canWrite, empty }: { recalls: RecallDTO[]; timezone: string; canWrite: boolean; empty: { title: string; hint?: string } }) {
  if (!recalls.length) {
    return (
      <div className="p-6">
        <EmptyState title={empty.title} hint={empty.hint} />
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border" aria-label="Recalls">
      {recalls.map((r) => (
        <RecallRow key={r.id} recall={r} timezone={timezone} canWrite={canWrite} />
      ))}
    </ul>
  );
}

function RecallRow({ recall: r, timezone, canWrite }: { recall: RecallDTO; timezone: string; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const phone = phoneOf(r);
  const owner = r.owner?.name ?? OWNER_ROLE_LABEL[r.ownerRole as keyof typeof OWNER_ROLE_LABEL] ?? r.ownerRole;
  const last = lastLine(r, timezone);
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_minmax(0,1.3fr)_auto] lg:items-start">
        <div className="min-w-0">
          <Link href={`/dashboard/patients/${r.patient.id}?tab=overview`} className="block truncate font-medium hover:underline">
            {r.patient.fullName}
          </Link>
          {phone ? (
            <a href={`tel:${phone}`} className="font-mono text-xs text-muted-foreground hover:text-foreground">
              {phone}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">No phone on record</span>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-sm">{r.label}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <BandBadge recall={r} />
            <Badge>{r.kindLabel}</Badge>
            {r.value > 0 ? <span className="font-mono text-xs tabular-nums text-muted-foreground">{egp(r.value)}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Due {formatDateInTz(new Date(r.dueAt), timezone, { day: "numeric", month: "short", year: "numeric" })} – {formatDateInTz(new Date(r.windowEndAt), timezone, { day: "numeric", month: "short" })} · {owner} · {CHANNEL_LABEL[r.channel as keyof typeof CHANNEL_LABEL] ?? r.channel}
          </p>
        </div>
        <div className="min-w-0 space-y-1 text-sm">
          <p>
            <span className="font-medium">{r.statusLabel}</span>
            {r.attempts ? <span className="text-muted-foreground"> · {r.attempts} tr{r.attempts === 1 ? "y" : "ies"}</span> : null}
            {r.booked ? <span className="text-muted-foreground"> · {when(r.booked.startsAt, timezone)}{r.booked.doctorName ? ` with ${r.booked.doctorName}` : ""}</span> : null}
            {r.status === "SNOOZED" && r.snoozedUntil ? <span className="text-muted-foreground"> · until {formatDateInTz(new Date(r.snoozedUntil), timezone, { day: "numeric", month: "short" })}</span> : null}
            {r.declineLabel ? <span className="text-muted-foreground"> · {r.declineLabel}</span> : null}
          </p>
          {r.nextContactAt && (r.status === "CONTACTED" || r.status === "OPEN") ? (
            <p className="text-xs text-muted-foreground">Next try {formatDateInTz(new Date(r.nextContactAt), timezone, { weekday: "short", day: "numeric", month: "short" })}</p>
          ) : null}
          {last ? <p className="truncate text-xs text-muted-foreground" title={r.lastActivity?.note ?? undefined}>{last}</p> : null}
          {r.hint ? <p className="text-xs text-warning">{r.hint}</p> : null}
          {r.suggestUnreachable ? <p className="text-xs text-warning">Tried {r.attempts} times without an answer: end it as unreachable?</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
          {canWrite ? <RecallActions recall={r} timezone={timezone} className="contents" /> : null}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} the log of ${r.patient.fullName}'s recall`}
            className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Log
            {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </div>
      </div>
      {open ? <RecallLog recallId={r.id} timezone={timezone} /> : null}
    </li>
  );
}

/** Everything done on a recall, oldest first, loaded when opened. */
export function RecallLog({ recallId, timezone }: { recallId: string; timezone: string }) {
  const [state, setState] = useState<{ activities: RecallActivityDTO[] | null; error: string | null }>({ activities: null, error: null });
  useEffect(() => {
    let live = true;
    apiFetch<{ recall: RecallDetailDTO }>(`/api/recalls/${recallId}`)
      .then((res) => live && setState({ activities: res.recall.activities, error: null }))
      .catch((err: unknown) => live && setState({ activities: null, error: recallErrorMessage(err) }));
    return () => {
      live = false;
    };
  }, [recallId]);
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
      {state.error ? (
        <p className="text-xs text-danger">{state.error}</p>
      ) : !state.activities ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        <ol className="space-y-2" aria-label="Recall log">
          {state.activities.map((a) => {
            const Icon = ACTIVITY_ICON[a.kind];
            return (
              <li key={a.id} className="flex gap-2 text-xs">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p>
                    <span className="font-medium">{a.kind === "CALL" ? `Call: ${a.outcomeLabel}` : a.kind === "MESSAGE" ? `WhatsApp: ${a.outcomeLabel}` : a.kind === "NOTE" ? "Note" : a.outcomeLabel}</span>
                    <span className="text-muted-foreground"> · {a.by?.name ?? "automatically"} · {when(a.at, timezone)}</span>
                  </p>
                  {a.note ? <p className={cn("whitespace-pre-wrap text-muted-foreground", a.kind === "MESSAGE" && "rounded bg-card px-2 py-1")}>{a.note}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
