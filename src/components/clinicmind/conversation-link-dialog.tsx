"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { LeadCardDTO } from "@/modules/crm/dto";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { StageBadge, crmErrorMessage } from "./lead-shared";
import { useDebouncedSearch } from "./conversation-hooks";

/**
 * Tie a thread to the patient or the lead it belongs to (search either), or
 * untie it. Linking a patient also lets the inbox fill {{doctor}} and {{date}}.
 */
export function ConversationLinkDialog({
  conversation,
  onOpenChange,
  onDone,
}: {
  conversation: { id: string; patient: { id: string; fullName: string } | null; lead: { id: string; fullName: string } | null; contactPhone: string | null };
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const [kind, setKind] = useState<"patient" | "lead">(conversation.patient ? "lead" : "patient");
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [lead, setLead] = useState<LeadCardDTO | null>(null);
  const [q, setQ] = useState(conversation.contactPhone?.replace(/\D/g, "").slice(-9) ?? "");
  const results = useDebouncedSearch<LeadCardDTO>(kind === "lead" ? q : "", (term, signal) =>
    apiFetch<{ leads: LeadCardDTO[] }>(`/api/leads?q=${encodeURIComponent(term)}&pageSize=8`, { signal }).then((r) => r.leads),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, string | null>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/conversations/${conversation.id}`, { method: "PATCH", body });
      toast({ title: message, tone: "success" });
      onDone();
    } catch (err) {
      setError(crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const current = kind === "patient" ? conversation.patient : conversation.lead;
  const tab = (value: "patient" | "lead", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={kind === value}
      onClick={() => {
        setKind(value);
        setError(null);
      }}
      className={cn("inline-flex h-7 items-center rounded-md px-3 text-sm font-medium", kind === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
    >
      {label}
    </button>
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Link this conversation" description="Attach the thread to the patient or the lead it belongs to.">
        <div className="space-y-4">
          <div role="tablist" className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1">
            {tab("patient", "Patient")}
            {tab("lead", "Lead")}
          </div>
          {error ? <Alert>{error}</Alert> : null}
          {current ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <span className="min-w-0 truncate">
                Linked to <strong>{current.fullName}</strong>
              </span>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void patch(kind === "patient" ? { patientId: null } : { leadId: null }, `Unlinked ${current.fullName}`)}>
                Unlink
              </Button>
            </div>
          ) : null}
          {kind === "patient" ? (
            <PatientPicker value={patient} onChange={setPatient} />
          ) : (
            <div className="space-y-2">
              <label htmlFor={`${id}-lead`} className="data-label block">
                Lead
              </label>
              <Input id={`${id}-lead`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or phone" autoComplete="off" />
              <ul className="max-h-56 space-y-1 overflow-y-auto" aria-label="Matching leads">
                {results === null && q.trim() ? <li className="px-2 py-1.5 text-xs text-muted-foreground">Searching…</li> : null}
                {results?.length === 0 ? <li className="px-2 py-1.5 text-xs text-muted-foreground">No lead matches.</li> : null}
                {results?.map((l) => (
                  <li key={l.id}>
                    <button
                      type="button"
                      onClick={() => setLead(l)}
                      aria-pressed={lead?.id === l.id}
                      className={cn("flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm", lead?.id === l.id ? "bg-accent-muted" : "hover:bg-muted")}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{l.fullName}</span>
                        <span className="block font-mono text-xs text-muted-foreground">{l.phone ?? "—"}</span>
                      </span>
                      <StageBadge stage={l.stage} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            {kind === "patient" ? (
              <Button type="button" disabled={busy || !patient} onClick={() => patient && void patch({ patientId: patient.id }, `Linked to ${patient.fullName}`)}>
                Link patient
              </Button>
            ) : (
              <Button type="button" disabled={busy || !lead} onClick={() => lead && void patch({ leadId: lead.id }, `Linked to ${lead.fullName}`)}>
                Link lead
              </Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
