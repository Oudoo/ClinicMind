"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Archive, BookOpen, CheckCircle2, ExternalLink, Loader2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import { cn, formatDate } from "@/lib/utils";
import { EVIDENCE_KIND_LABEL, EVIDENCE_KINDS } from "@/modules/evidence/constants";
import type { EvidenceSourceDetailDTO, EvidenceSourceDTO } from "@/modules/evidence/dto";

type Filter = "APPROVED" | "DRAFT" | "RETIRED" | "ALL";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "APPROVED", label: "Approved" },
  { key: "DRAFT", label: "Waiting for approval" },
  { key: "RETIRED", label: "Retired" },
  { key: "ALL", label: "All" },
];

const STATUS_TONE = { APPROVED: "success", DRAFT: "warning", RETIRED: "default" } as const;

/**
 * The clinic's evidence library: what the evidence panel may quote. Doctors
 * and the owner add sources (the text itself, who wrote it, when); the owner
 * approves them, and retires one the clinic no longer follows.
 */
export function EvidenceLibrary({ sources, canWrite, canApprove, openId }: { sources: EvidenceSourceDTO[]; canWrite: boolean; canApprove: boolean; openId?: string }) {
  const router = useRouter();
  const counts = { APPROVED: 0, DRAFT: 0, RETIRED: 0, ALL: sources.length };
  for (const s of sources) counts[s.status] += 1;
  const [filter, setFilter] = useState<Filter>(() => (counts.DRAFT && canApprove ? "DRAFT" : "APPROVED"));
  const [reading, setReading] = useState<string | null>(openId ?? null);
  const [editing, setEditing] = useState<EvidenceSourceDTO | "new" | null>(null);
  const shown = filter === "ALL" ? sources : sources.filter((s) => s.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Sources by status" className="-mx-1 overflow-x-auto px-1">
          <ul className="inline-flex h-auto min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1">
            {FILTERS.map((f) => (
              <li key={f.key}>
                <button
                  type="button"
                  onClick={() => setFilter(f.key)}
                  aria-pressed={filter === f.key}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                    filter === f.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">{counts[f.key]}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {canWrite ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a source
          </Button>
        ) : null}
      </div>

      {shown.length ? (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2" data-testid="evidence-sources">
          {shown.map((s) => (
            <li key={s.id}>
              <SourceCard source={s} canWrite={canWrite} canApprove={canApprove} onRead={() => setReading(s.id)} onEdit={() => setEditing(s)} onChanged={() => router.refresh()} />
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <EmptyState
            title={filter === "DRAFT" ? "Nothing is waiting for approval" : filter === "RETIRED" ? "No source is retired" : "No source here yet"}
            hint={canWrite ? "Add a guideline, drug information or one of the clinic's protocols: paste the text the panel may quote." : "Doctors add sources; the clinic owner approves them."}
          />
        </Card>
      )}

      {reading ? <SourceReader id={reading} onOpenChange={(o) => !o && setReading(null)} /> : null}
      {editing ? (
        <SourceDialog
          source={editing === "new" ? null : editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onDone={(saved) => {
            setEditing(null);
            if (saved.status === "DRAFT") setFilter("DRAFT");
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function SourceCard({ source: s, canWrite, canApprove, onRead, onEdit, onChanged }: { source: EvidenceSourceDTO; canWrite: boolean; canApprove: boolean; onRead: () => void; onEdit: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<"approve" | "retire" | null>(null);
  const [busy, setBusy] = useState(false);
  const by = [s.publisher, s.year].filter(Boolean).join(", ");

  async function act(action: "approve" | "retire") {
    setBusy(true);
    try {
      await apiFetch(`/api/evidence/sources/${s.id}`, { method: "PATCH", body: { action } });
      toast({ title: action === "approve" ? "Approved: the panel may quote it" : "Retired: the panel no longer quotes it", tone: "success" });
      setConfirm(null);
      onChanged();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "That did not work. Try again.", tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-full space-y-2" data-testid="evidence-source">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium" dir="auto">
            {s.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {s.kindLabel}
            {by ? ` · ${by}` : ""} · {s.language === "ar" ? "Arabic" : "English"} · {s.passages} {s.passages === 1 ? "passage" : "passages"}
          </p>
        </div>
        <Badge tone={STATUS_TONE[s.status]} className="shrink-0">
          {s.statusLabel}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {s.status === "APPROVED" && s.approvedAt
          ? `Approved by ${s.approvedBy ?? "the clinic"} on ${formatDate(s.approvedAt)}`
          : s.status === "RETIRED" && s.retiredAt
            ? `Retired on ${formatDate(s.retiredAt)}`
            : `Added by ${s.createdBy ?? "the clinic"} on ${formatDate(s.createdAt)}`}
        {s.status !== "DRAFT" || s.updatedAt === s.createdAt ? "" : ` · changed ${formatDate(s.updatedAt)}`}
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={onRead}>
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          Read
        </Button>
        {canWrite && s.status !== "RETIRED" ? (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit
          </Button>
        ) : null}
        {canApprove && s.status === "DRAFT" ? (
          <Button size="sm" onClick={() => setConfirm("approve")} disabled={busy}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Approve
          </Button>
        ) : null}
        {canApprove && s.status !== "RETIRED" ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirm("retire")} disabled={busy}>
            <Archive className="h-4 w-4" aria-hidden="true" />
            Retire
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "approve" ? `Approve “${s.title}”?` : `Retire “${s.title}”?`}
        description={
          confirm === "approve"
            ? "The evidence panel may quote it from now on. Read it first: the panel quotes it word for word."
            : "The evidence panel stops quoting it. Answers that cited it keep showing it."
        }
        confirmLabel={confirm === "approve" ? "Approve" : "Retire"}
        tone={confirm === "retire" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => (confirm ? act(confirm) : undefined)}
      />
    </Card>
  );
}

function SourceReader({ id, onOpenChange }: { id: string; onOpenChange: (open: boolean) => void }) {
  const [source, setSource] = useState<EvidenceSourceDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ source: EvidenceSourceDetailDTO }>(`/api/evidence/sources/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setSource(data.source);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError && err.status === 404 ? "This source is not in the clinic's library." : err instanceof Error ? err.message : "The source could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const by = source ? [source.publisher, source.year].filter(Boolean).join(", ") : "";
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={source?.title ?? "Source"} description={source ? `${source.kindLabel}${by ? ` · ${by}` : ""} · ${source.statusLabel}` : undefined} className="max-w-2xl">
        {error ? <Alert>{error}</Alert> : null}
        {!source && !error ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </p>
        ) : null}
        {source ? (
          <div className="space-y-3" data-testid="evidence-reader">
            {source.url ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-accent underline-offset-2 hover:underline">
                The original
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            ) : null}
            <p className="text-xs text-muted-foreground">
              What the panel cites: {source.passageList.length} {source.passageList.length === 1 ? "passage" : "passages"}, each with the heading it sits under.
            </p>
            <ol className="space-y-2">
              {source.passageList.map((p) => (
                <li key={p.index} className="rounded-md border border-border px-3 py-2 text-sm">
                  {p.heading ? <p className="data-label mb-1">{p.heading}</p> : null}
                  <p dir="auto" className="whitespace-pre-line">
                    {p.content}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SourceDialog({ source, onOpenChange, onDone }: { source: EvidenceSourceDTO | null; onOpenChange: (open: boolean) => void; onDone: (saved: EvidenceSourceDTO) => void }) {
  const id = useId();
  const { toast } = useToast();
  const [title, setTitle] = useState(source?.title ?? "");
  const [kind, setKind] = useState<string>(source?.kind ?? "PROTOCOL");
  const [publisher, setPublisher] = useState(source?.publisher ?? "");
  const [year, setYear] = useState(source?.year ? String(source.year) : "");
  const [url, setUrl] = useState(source?.url ?? "");
  const [language, setLanguage] = useState(source?.language ?? "en");
  const [body, setBody] = useState("");
  const [loaded, setLoaded] = useState(!source);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editing: the text comes with the source's detail (once: a refresh of the list leaves the edits alone).
  const sourceId = source?.id;
  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;
    apiFetch<{ source: EvidenceSourceDetailDTO }>(`/api/evidence/sources/${sourceId}`)
      .then((data) => {
        if (cancelled) return;
        setBody(data.source.body);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "The source could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !loaded) return;
    setBusy(true);
    setIssues({});
    setError(null);
    const payload = { title, kind, publisher, year, url, language, body };
    try {
      const { source: saved } = source
        ? await apiFetch<{ source: EvidenceSourceDetailDTO }>(`/api/evidence/sources/${source.id}`, { method: "PATCH", body: payload })
        : await apiFetch<{ source: EvidenceSourceDetailDTO }>("/api/evidence/sources", { method: "POST", body: payload });
      toast({
        title: source ? "Source saved" : "Source added",
        description: saved.status === "DRAFT" ? "It waits for the owner's approval before the panel quotes it." : undefined,
        tone: "success",
      });
      onDone(saved);
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length) setIssues(fields);
      else setError(err instanceof Error ? err.message : "The source could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={source ? "Edit source" : "Add a source"}
        description={
          source?.status === "APPROVED"
            ? "Changing its text, title, publisher or year sends it back for the owner's approval; until then the panel does not quote it."
            : "The text itself, as the panel may quote it. The owner approves it first."
        }
        className="max-w-2xl"
      >
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label="Title" htmlFor={`${id}-title`} hint={issues.title}>
            <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} dir="auto" required />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Kind" htmlFor={`${id}-kind`} hint={issues.kind}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value)}>
                {EVIDENCE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EVIDENCE_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Language" htmlFor={`${id}-language`} hint={issues.language}>
              <Select id={`${id}-language`} value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="en">English</option>
                <option value="ar">Arabic</option>
              </Select>
            </Field>
            <Field label="Year" htmlFor={`${id}-year`} hint={issues.year}>
              <Input id={`${id}-year`} inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="2025" />
            </Field>
          </div>
          <Field label="Publisher or author" htmlFor={`${id}-publisher`} hint={issues.publisher}>
            <Input id={`${id}-publisher`} value={publisher} onChange={(e) => setPublisher(e.target.value)} maxLength={200} dir="auto" />
          </Field>
          <Field label="Web address of the original (optional)" htmlFor={`${id}-url`} hint={issues.url}>
            <Input id={`${id}-url`} type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} placeholder="https://" />
          </Field>
          <Field
            label="Text"
            htmlFor={`${id}-body`}
            hint={issues.body ?? "Headings on their own line (“Monitoring:” or “# Monitoring”) keep each passage with its heading."}
          >
            <Textarea id={`${id}-body`} rows={12} value={body} onChange={(e) => setBody(e.target.value)} maxLength={60_000} dir="auto" disabled={!loaded} />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !loaded}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {source ? "Save" : "Add source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
