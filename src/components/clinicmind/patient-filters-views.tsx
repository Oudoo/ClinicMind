"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bookmark, BookmarkPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { hasPatientFilters, patientFiltersOnly, type PatientListQuery } from "@/modules/patients/filters";
import { apiErrorMessage } from "@/components/clinicmind/patient-shared";

export interface SavedViewDTO {
  id: string;
  name: string;
  params: Record<string, string>;
}

const ITEM =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-foreground outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-muted";

/**
 * Saved views: the user's named filter sets. They are applied from the "View" list of the
 * filter bar; this menu beside it saves the current filters under a name and opens a saved
 * view to rename it, replace its filters with the current ones, or delete it.
 */
export function PatientSavedViews({ query, views }: { query: PatientListQuery; views: SavedViewDTO[] }) {
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<SavedViewDTO | null>(null);
  const filtered = hasPatientFilters(query) || Boolean(query.sort);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label="Saved views" title="Save this view, or change a saved one">
            <Bookmark className="h-4 w-4" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[14rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-1 text-sm shadow-lg animate-fade-in"
          >
            <DropdownMenu.Item className={ITEM} disabled={!filtered} onSelect={() => setSaving(true)}>
              <BookmarkPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
              Save view
            </DropdownMenu.Item>
            {!filtered ? <p className="px-2.5 pb-1.5 text-xs text-muted-foreground">Set a filter or a sort order first.</p> : null}
            {views.length ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Label className="px-2.5 py-1.5 text-xs text-muted-foreground">Rename, update or delete</DropdownMenu.Label>
                {views.map((view) => (
                  <DropdownMenu.Item key={view.id} className={ITEM} onSelect={() => setEditing(view)} aria-label={`Manage saved view ${view.name}`}>
                    <span className="min-w-0 truncate">{view.name}</span>
                  </DropdownMenu.Item>
                ))}
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

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
      <DialogContent title="Save view" description="Keeps the current filters and sort order under a name, for you only.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="e.g. Hair transplant follow-ups"
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
      <DialogContent title={`Saved view: ${view.name}`} description="Rename it, replace its filters with the current ones, or delete it.">
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
              <Button type="submit" variant="outline" className="h-10" disabled={busy !== null || !name.trim() || name.trim() === view.name}>
                {busy === "rename" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Rename
              </Button>
            </div>
          </Field>
          <DialogFooter className="justify-between sm:justify-between">
            <Button type="button" variant="ghost" className="text-danger hover:bg-danger/10" onClick={() => void run("delete")} disabled={busy !== null}>
              {busy === "delete" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Delete view
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
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
