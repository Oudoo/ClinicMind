"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
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

function Workspace({ initial, canSign, userId, openId, presetPatient }: ConsultationsWorkspaceProps) {
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
      <div ref={panelRef} className="min-w-0 scroll-mt-4">
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
