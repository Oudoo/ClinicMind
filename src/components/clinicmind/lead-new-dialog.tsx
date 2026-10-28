"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import { LEAD_SOURCES, SOURCE_LABELS, type LeadSourceKey } from "@/modules/crm/shared";
import type { LeadCardDTO } from "@/modules/crm/dto";
import { crmErrorMessage, type CampaignOption, type StaffOption, type TreatmentOption } from "./lead-shared";

export interface LeadFormValues {
  fullName: string;
  phone: string;
  whatsapp: string;
  email: string;
  source: LeadSourceKey;
  campaignId: string;
  interests: string[];
  ownerId: string;
  notes: string;
  stage: "NEW" | "CONTACTED" | "QUALIFIED";
}

export const EMPTY_LEAD: LeadFormValues = {
  fullName: "",
  phone: "",
  whatsapp: "",
  email: "",
  source: "CLICK_TO_WHATSAPP_AD",
  campaignId: "",
  interests: [],
  ownerId: "",
  notes: "",
  stage: "NEW",
};

export interface LeadFormOptions {
  treatments: TreatmentOption[];
  staff: StaffOption[];
  campaigns: CampaignOption[];
}

/** "New lead" on the leads page: the form, then the new lead's page. */
export function NewLeadButton({ options, defaultOwnerId }: { options: LeadFormOptions; defaultOwnerId?: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" />
        New lead
      </Button>
      {open ? (
        <LeadFormDialog
          mode="create"
          initial={{ ...EMPTY_LEAD, ownerId: defaultOwnerId ?? "" }}
          options={options}
          onOpenChange={setOpen}
          onDone={(lead) => {
            setOpen(false);
            router.push(`/dashboard/leads/${lead.id}`);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Create or edit a lead: contact details, source and campaign, the treatments
 * asked about, the owner and notes (with the microphone). `conversationId`
 * links a new lead to an inbox thread ("Create lead from this thread").
 */
export function LeadFormDialog({
  mode,
  leadId,
  initial,
  options,
  conversationId,
  title,
  onOpenChange,
  onDone,
}: {
  mode: "create" | "edit";
  leadId?: string;
  initial: LeadFormValues;
  options: LeadFormOptions;
  conversationId?: string;
  title?: string;
  onOpenChange: (open: boolean) => void;
  onDone: (lead: LeadCardDTO) => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const [values, setValues] = useState<LeadFormValues>(initial);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const toggleInterest = (key: string) =>
    setValues((v) => ({ ...v, interests: v.interests.includes(key) ? v.interests.filter((k) => k !== key) : [...v.interests, key] }));

  // Inactive campaigns stay selectable only when the lead already carries one.
  const campaigns = options.campaigns.filter((c) => c.active || c.id === initial.campaignId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!values.fullName.trim()) {
      setIssues({ fullName: "Enter the lead's name." });
      return;
    }
    setBusy(true);
    setError(null);
    setIssues({});
    const body = {
      fullName: values.fullName,
      phone: values.phone,
      whatsapp: values.whatsapp,
      email: values.email,
      source: values.source,
      campaignId: values.campaignId,
      interests: values.interests,
      ownerId: values.ownerId,
      notes: values.notes,
      ...(mode === "create" ? { stage: values.stage, ...(conversationId ? { conversationId } : {}) } : {}),
    };
    try {
      const res =
        mode === "create"
          ? await apiFetch<{ lead: LeadCardDTO }>("/api/leads", { method: "POST", body })
          : await apiFetch<{ lead: LeadCardDTO }>(`/api/leads/${leadId}`, { method: "PATCH", body });
      toast({ title: mode === "create" ? `Lead added: ${res.lead.fullName}` : "Lead updated", tone: "success" });
      onDone(res.lead);
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={title ?? (mode === "create" ? "New lead" : "Edit lead")} description="Phones are saved in international form (+20…)." className="max-w-2xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Full name" htmlFor={`${id}-name`} hint={hint("fullName")}>
            <Input id={`${id}-name`} value={values.fullName} onChange={(e) => set("fullName", e.target.value)} maxLength={120} autoFocus aria-invalid={issues.fullName ? true : undefined} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Phone" htmlFor={`${id}-phone`} hint={hint("phone")}>
              <Input id={`${id}-phone`} type="tel" inputMode="tel" value={values.phone} onChange={(e) => set("phone", e.target.value)} placeholder="010 1234 5678" aria-invalid={issues.phone ? true : undefined} />
            </Field>
            <Field label="WhatsApp" htmlFor={`${id}-wa`} hint={hint("whatsapp", "Blank: same as the phone")}>
              <Input id={`${id}-wa`} type="tel" inputMode="tel" value={values.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} aria-invalid={issues.whatsapp ? true : undefined} />
            </Field>
            <Field label="E-mail" htmlFor={`${id}-email`} hint={hint("email")}>
              <Input id={`${id}-email`} type="email" value={values.email} onChange={(e) => set("email", e.target.value)} aria-invalid={issues.email ? true : undefined} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Source" htmlFor={`${id}-source`} hint={hint("source")}>
              <Select id={`${id}-source`} value={values.source} onChange={(e) => set("source", e.target.value as LeadSourceKey)}>
                {LEAD_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Campaign" htmlFor={`${id}-campaign`} hint={hint("campaignId")}>
              <Select id={`${id}-campaign`} value={values.campaignId} onChange={(e) => set("campaignId", e.target.value)}>
                <option value="">No campaign</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Owner" htmlFor={`${id}-owner`} hint={hint("ownerId")}>
              <Select id={`${id}-owner`} value={values.ownerId} onChange={(e) => set("ownerId", e.target.value)}>
                <option value="">Unassigned</option>
                {options.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="data-label">Interested in</legend>
            <div className="flex flex-wrap gap-1.5">
              {options.treatments.map((t) => {
                const on = values.interests.includes(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleInterest(t.key)}
                    className={cn(
                      "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "border-accent bg-accent-muted text-accent" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
            {issues.interests ? <p className="text-xs text-danger">{issues.interests}</p> : null}
          </fieldset>
          {mode === "create" ? (
            <Field label="Starts at" htmlFor={`${id}-stage`} hint="Walk-ins and phone enquiries may already be contacted or qualified.">
              <Select id={`${id}-stage`} value={values.stage} onChange={(e) => set("stage", e.target.value as LeadFormValues["stage"])} className="sm:w-60">
                <option value="NEW">New</option>
                <option value="CONTACTED">Contacted</option>
                <option value="QUALIFIED">Qualified</option>
              </Select>
            </Field>
          ) : null}
          <Field label="Notes" htmlFor={`${id}-notes`} hint={hint("notes", "What they asked, when to call, anything the next person should know.")}>
            <DictationField onDictated={(v) => set("notes", v)} disabled={busy}>
              <Textarea id={`${id}-notes`} value={values.notes} onChange={(e) => set("notes", e.target.value)} maxLength={4000} className="min-h-[5rem]" />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : mode === "create" ? "Add lead" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
