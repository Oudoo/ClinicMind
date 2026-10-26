"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, BookmarkPlus, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import {
  hasPatientFilters,
  matchesQuickView,
  parsePatientListQuery,
  patientFiltersOnly,
  type PatientListQuery,
} from "@/modules/patients/filters";
import { apiErrorMessage } from "@/components/clinicmind/patient-shared";

export interface SavedViewDTO {
  id: string;
  name: string;
  params: Record<string, string>;
}

/**
 * Saved views: the user's named filter sets, as chips next to the quick
 * views. "Save view" stores the current filters; the menu on a chip renames,
 * overwrites it with the current filters, or deletes it.
 */
export function PatientSavedViews({
  query,
  views,
  onApply,
}: {
  query: PatientListQuery;
  views: SavedViewDTO[];
  onApply: (query: PatientListQuery) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SavedViewDTO | null>(null);
  const filtered = hasPatientFilters(query) || Boolean(query.sort);

  return (
    <>
      {views.map((view) => {
        const viewQuery = parsePatientListQuery(view.params);
        const active = matchesQuickView(query, viewQuery) && (query.sort ?? "newest") === (viewQuery.sort ?? "newest");
        return (
          <span
            key={view.id}
            className={cn(
              "inline-flex h-8 items-center overflow-hidden rounded-full border text-xs font-medium",
              active ? "border-accent bg-accent-muted text-accent" : "border-border bg-card text-muted-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onApply(viewQuery)}
              aria-pressed={active}
              className="inline-flex h-full items-center gap-1 pl-3 pr-2 hover:bg-muted hover:text-foreground"
            >
              <Bookmark className="h-3 w-3" />
              {view.name}
            </button>
            <button
              type="button"
              onClick={() => setEditing(view)}
              aria-label={`Manage saved view ${view.name}`}
              className="inline-flex h-full items-center border-l border-border px-1.5 hover:bg-muted hover:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </span>
        );
      })}
      <button
        type="button"
        onClick={() => setSaving(true)}
        disabled={!filtered}
        title={filtered ? "Save the current filters as a view" : "Set a filter first"}
        className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <BookmarkPlus className="h-3.5 w-3.5" />
        Save view
      </button>

      {saving ? <SaveViewDialog query={query} onClose={() => setSaving(false)} /> : null}
      {editing ? <ManageViewDialog view={editing} query={query} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function SaveViewDialog({ query, onClose }: { query: PatientListQuery; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/patients/views", { method: "POST", body: { name: name.trim(), params: patientFiltersOnly(query) } });
      toast({ title: "View saved", description: name.trim(), tone: "success" });
      router.refresh();
      onClose();
    } catch (err) {
      setError(fieldErrors(err).name ?? apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent title="Save view" description="Keeps the current filters and sort under a name, for you only.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Hair-transplant follow-ups"
              autoFocus
              required
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save view
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManageViewDialog({ view, query, onClose }: { view: SavedViewDTO; query: PatientListQuery; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(view.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "update" | "delete" | null>(null);

  async function run(kind: "rename" | "update" | "delete") {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "delete") {
        await apiFetch(`/api/patients/views/${view.id}`, { method: "DELETE" });
        toast({ title: "View deleted", description: view.name, tone: "success" });
      } else {
        await apiFetch(`/api/patients/views/${view.id}`, {
          method: "PATCH",
          body: kind === "rename" ? { name: name.trim() } : { params: patientFiltersOnly(query) },
        });
        toast({ title: kind === "rename" ? "View renamed" : "View updated with the current filters", tone: "success" });
      }
      router.refresh();
      onClose();
    } catch (err) {
      setError(fieldErrors(err).name ?? apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent title={`Saved view · ${view.name}`} description="Rename it, replace its filters with the current ones, or delete it.">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("rename");
          }}
          className="space-y-4"
          noValidate
        >
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`}>
            <div className="flex gap-2">
              <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
              <Button type="submit" variant="outline" disabled={busy !== null || !name.trim() || name.trim() === view.name}>
                {busy === "rename" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Rename
              </Button>
            </div>
          </Field>
          <DialogFooter className="justify-between">
            <Button type="button" variant="ghost" className="text-danger hover:bg-danger/10" onClick={() => void run("delete")} disabled={busy !== null}>
              {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={busy !== null}>
                Close
              </Button>
              <Button type="button" onClick={() => void run("update")} disabled={busy !== null || !hasPatientFilters(query)}>
                {busy === "update" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Use current filters
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
