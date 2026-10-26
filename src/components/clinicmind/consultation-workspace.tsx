"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardPaste, Mic, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { formatDateTimeInTz } from "@/lib/time";
import type { AppointmentDTO, AppointmentNoteDTO } from "@/modules/appointments/dto";
import { KIND_LABEL, LANGUAGE_LABEL } from "@/modules/appointments/transitions";
import type {
  ConsultationDetail,
  ConsultationListItem,
  ConsultationListResponse,
  PatientOption,
} from "@/modules/consultations/types";
import { ConsultationList, type ListFilter } from "./consultation-list";
import { ConsultationPanel } from "./consultation-panel";

const LIST_PAGE_SIZE = 30;

export interface ConsultationsWorkspaceProps {
  initial: ConsultationListResponse;
  canSign: boolean;
  userId: string | null;
  /** Consultation to open on load (`?id=`). */
  openId?: string;
  /** Patient to preselect for a new capture (`?patientId=`). */
  presetPatient: PatientOption | null;
  /** The appointment the capture starts from (`?appointmentId=`), with the notes dictated at booking. */
  presetAppointment?: AppointmentDTO | null;
  /** The clinic clock, for the times on the dictated notes. */
  timezone?: string;
}

/**
 * Two-pane consultation workspace: the recent list on the left (stacked above
 * the panel on phones), capture / review / detail on the right. Mounts its
 * own ToastProvider because the dashboard layout does not provide one yet.
 */
export function ConsultationsWorkspace(props: ConsultationsWorkspaceProps) {
  return (
    <ToastProvider>
      <Workspace {...props} />
    </ToastProvider>
  );
}

interface Selection {
  id: string | null;
  /** Changes whenever the selection is (re)made, so the panel remounts with fresh state. */
  nonce: number;
}

function Workspace({ initial, canSign, userId, openId, presetPatient, presetAppointment = null, timezone = "Africa/Cairo" }: ConsultationsWorkspaceProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<ConsultationListItem[]>(initial.consultations);
  const [total, setTotal] = useState(initial.total);
  const [filter, setFilter] = useState<ListFilter>("ALL");
  const [listLoading, setListLoading] = useState(false);
  const [selection, setSelection] = useState<Selection>({ id: openId ?? null, nonce: 0 });
  const [detail, setDetail] = useState<ConsultationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(openId));
  const panelRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(
    async (status: ListFilter) => {
      setListLoading(true);
      try {
        const query = `pageSize=${LIST_PAGE_SIZE}${status === "ALL" ? "" : `&status=${status}`}`;
        const data = await apiFetch<ConsultationListResponse>(`/api/consultations?${query}`);
        setItems(data.consultations);
        setTotal(data.total);
      } catch (err) {
        toast({
          title: "Could not refresh the list",
          description: err instanceof Error ? err.message : undefined,
          tone: "danger",
        });
      } finally {
        setListLoading(false);
      }
    },
    [toast],
  );

  const refresh = useCallback(() => loadList(filter), [loadList, filter]);

  useEffect(() => {
    const id = selection.id;
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<{ consultation: ConsultationDetail }>(`/api/consultations/${id}`);
        if (!cancelled) setDetail(data.consultation);
      } catch (err) {
        if (cancelled) return;
        toast({
          title: "Consultation not found",
          description: err instanceof Error ? err.message : undefined,
          tone: "danger",
        });
        setSelection({ id: null, nonce: Date.now() });
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selection, toast]);

  function select(id: string | null) {
    setSelection({ id, nonce: Date.now() });
    setDetail(null);
    setDetailLoading(Boolean(id));
    // On phones the panel sits below the list: bring it into view.
    if (window.innerWidth < 1024) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function onFilterChange(next: ListFilter) {
    setFilter(next);
    void loadList(next);
  }

  function onClosed() {
    select(null);
    void refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <ConsultationList
        items={items}
        total={total}
        loading={listLoading}
        filter={filter}
        selectedId={selection.id}
        onFilterChange={onFilterChange}
        onSelect={select}
        onNew={() => select(null)}
      />
      <div ref={panelRef} className="min-w-0 scroll-mt-4 space-y-4">
        {!selection.id && presetAppointment ? <BookingNotesCard appointment={presetAppointment} timezone={timezone} /> : null}
        {detailLoading ? (
          <PanelSkeleton />
        ) : (
          <ConsultationPanel
            key={`${selection.id ?? "new"}:${selection.nonce}`}
            consultation={selection.id ? detail : null}
            presetPatient={presetPatient}
            canSign={canSign}
            userId={userId}
            onChanged={() => void refresh()}
            onClosed={onClosed}
            onNew={() => select(null)}
            onOpen={select}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Hand a value to a React-controlled field from outside its component: the
 * native setter bypasses React's value tracker, so the dispatched event is
 * seen as a real user edit and the owning component's onChange runs.
 */
function setNativeValue(el: HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change"): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

function formatSeconds(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * "Notes dictated at booking": what reception or the doctor dropped onto the
 * appointment, shown beside the capture form with one click to insert them
 * into the transcript. The capture form belongs to the consultation panel, so
 * the insertion and the appointment preselection go through the DOM fields it
 * renders (`#consultation-transcript`, `#consultation-appointment`).
 */
function BookingNotesCard({ appointment, timezone }: { appointment: AppointmentDTO; timezone: string }) {
  const { toast } = useToast();
  const notes = appointment.dictatedNotes ?? [];
  const start = new Date(appointment.startsAt);

  // Preselect the appointment once the capture form has loaded the patient's bookings.
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      const select = document.getElementById("consultation-appointment");
      if (select instanceof HTMLSelectElement && Array.from(select.options).some((o) => o.value === appointment.id)) {
        if (select.value !== appointment.id) setNativeValue(select, appointment.id, "change");
        window.clearInterval(timer);
        return;
      }
      if (tries > 40) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, [appointment.id]);

  function insert(selected: AppointmentNoteDTO[]) {
    const el = document.getElementById("consultation-transcript");
    if (!(el instanceof HTMLTextAreaElement)) {
      toast({ title: "Start a new capture first", description: "The transcript box is not on the screen.", tone: "danger" });
      return;
    }
    const block = selected
      .map(
        (n) =>
          `[${n.kind === "DICTATION" ? "Dictated" : "Typed"} at booking · ${n.author?.fullName ?? "staff"} · ${formatDateTimeInTz(new Date(n.createdAt), timezone)}]\n${n.body}`,
      )
      .join("\n\n");
    const next = el.value.trim() ? `${el.value.trimEnd()}\n\n${block}` : block;
    setNativeValue(el, next, "input");
    el.focus();
    toast({ title: selected.length === 1 ? "Note inserted into the transcript" : `${selected.length} notes inserted into the transcript`, tone: "success" });
  }

  return (
    <Card className="space-y-3 border-accent/40" data-testid="booking-notes-card">
      <SectionTitle
        title="Notes dictated at booking"
        description={`${appointment.patient.fullName} · ${formatDateTimeInTz(start, timezone)} · ${KIND_LABEL[appointment.kind]}${appointment.reason ? ` · ${appointment.reason}` : ""}`}
        action={
          notes.length ? (
            <Button type="button" size="sm" onClick={() => insert(notes)}>
              <ClipboardPaste />
              Insert {notes.length === 1 ? "into transcript" : `all ${notes.length}`}
            </Button>
          ) : undefined
        }
      />
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes were dictated when this appointment was booked.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Badge tone={n.kind === "DICTATION" ? "accent" : "default"}>
                  {n.kind === "DICTATION" ? <Mic className="h-3 w-3" aria-hidden="true" /> : <Type className="h-3 w-3" aria-hidden="true" />}
                  {n.kind === "DICTATION" ? "Dictated" : "Typed"}
                </Badge>
                <span className="font-medium text-foreground">{n.author?.fullName ?? "Unknown"}</span>
                <time dateTime={n.createdAt} className="font-mono tabular-nums">
                  {formatDateTimeInTz(new Date(n.createdAt), timezone)}
                </time>
                {n.language ? <span>{LANGUAGE_LABEL[n.language] ?? n.language}</span> : null}
                {n.durationSeconds ? <span className="font-mono tabular-nums">{formatSeconds(n.durationSeconds)}</span> : null}
                <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 px-2" onClick={() => insert([n])}>
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  Insert
                </Button>
              </div>
              <p dir="auto" className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                {n.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PanelSkeleton() {
  return (
    <Card className="space-y-4" aria-busy="true">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-28" />
    </Card>
  );
}
