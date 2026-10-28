"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { insertAtCaret } from "@/lib/caret";
import type { TemplateDTO } from "@/modules/messaging/dto";
import { PLACEHOLDER_HINTS, TEMPLATE_PLACEHOLDERS } from "@/modules/messaging/placeholders";
import { crmErrorMessage } from "./lead-shared";

const CATEGORIES = ["booking", "price", "follow-up", "intake", "concierge"];

/** Settings → reply templates: the list, and (for owners) add and edit with the placeholders one tap away. */
export function InboxTemplatesEditor({ templates, canEdit }: { templates: TemplateDTO[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<TemplateDTO | "new" | null>(null);
  return (
    <section className="space-y-3" aria-label="Reply templates">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Reply templates</p>
          <p className="text-xs text-muted-foreground">
            Picked in the inbox's reply box; {TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")} are filled from the conversation.
          </p>
        </div>
        {canEdit ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" />
            Add template
          </Button>
        ) : null}
      </div>
      {templates.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{t.name}</span>
                  <Badge>{t.language.toUpperCase()}</Badge>
                  {t.category ? <Badge tone="accent">{t.category}</Badge> : null}
                  {t.active ? null : <Badge tone="warning">inactive</Badge>}
                </div>
                <p dir="auto" className="line-clamp-2 text-xs text-muted-foreground">
                  {t.body}
                </p>
              </div>
              {canEdit ? (
                <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">No templates yet.</p>
      )}
      {editing ? <TemplateDialog template={editing === "new" ? null : editing} onOpenChange={(open) => !open && setEditing(null)} /> : null}
    </section>
  );
}

function TemplateDialog({ template, onOpenChange }: { template: TemplateDTO | null; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [values, setValues] = useState({
    key: template?.key ?? "",
    name: template?.name ?? "",
    language: template?.language ?? "ar",
    category: template?.category ?? "booking",
    body: template?.body ?? "",
    active: template?.active ?? true,
  });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof values>(key: K, value: (typeof values)[K]) => setValues((v) => ({ ...v, [key]: value }));

  function insertPlaceholder(name: string) {
    const el = bodyRef.current;
    const next = insertAtCaret(values.body, el?.selectionStart ?? null, el?.selectionEnd ?? null, `{{${name}}}`);
    set("body", next.value);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    const { key, ...rest } = values;
    try {
      if (template) await apiFetch(`/api/messaging/templates/${template.id}`, { method: "PATCH", body: rest });
      else await apiFetch("/api/messaging/templates", { method: "POST", body: { key, ...rest } });
      toast({ title: template ? "Template saved" : `Template added: ${values.name}`, tone: "success" });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hint = (key: string, fallback?: React.ReactNode) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={template ? `Edit “${template.name}”` : "New reply template"} className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${id}-name`} hint={hint("name")}>
              <Input id={`${id}-name`} value={values.name} onChange={(e) => set("name", e.target.value)} maxLength={120} />
            </Field>
            {template ? (
              <Field label="Key" htmlFor={`${id}-key`} hint="Fixed once created">
                <Input id={`${id}-key`} value={values.key} disabled className="font-mono" />
              </Field>
            ) : (
              <Field label="Key" htmlFor={`${id}-key`} hint={hint("key", "Letters, digits and dashes, e.g. price-reply-ar")}>
                <Input id={`${id}-key`} value={values.key} onChange={(e) => set("key", e.target.value.toLowerCase())} maxLength={80} className="font-mono" />
              </Field>
            )}
            <Field label="Language" htmlFor={`${id}-lang`} hint={hint("language")}>
              <Select id={`${id}-lang`} value={values.language} onChange={(e) => set("language", e.target.value)}>
                <option value="ar">Arabic</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label="Category" htmlFor={`${id}-cat`} hint={hint("category")}>
              <Select id={`${id}-cat`} value={values.category} onChange={(e) => set("category", e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Insert a placeholder">
              {TEMPLATE_PLACEHOLDERS.map((p) => (
                <button key={p} type="button" onClick={() => insertPlaceholder(p)} title={PLACEHOLDER_HINTS[p]} className="inline-flex h-7 items-center rounded-full border border-border px-2.5 font-mono text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  {`{{${p}}}`}
                </button>
              ))}
            </div>
            <Field label="Text" htmlFor={`${id}-body`} hint={hint("body", "Anything the inbox cannot fill stays visible, and the reply cannot be sent until it is replaced.")}>
              <DictationField onDictated={(v) => set("body", v)} disabled={busy}>
                <Textarea ref={bodyRef} id={`${id}-body`} dir="auto" value={values.body} onChange={(e) => set("body", e.target.value)} maxLength={2000} className="min-h-[7rem]" />
              </DictationField>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={values.active} onChange={(e) => set("active", e.target.checked)} />
            Active (offered in the inbox)
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : template ? "Save template" : "Add template"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
