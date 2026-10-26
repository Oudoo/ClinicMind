"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, ExternalLink, Link2, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import type { IssuedIntakeLink } from "@/modules/intake/service";
import { PatientPicker, type PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { apiErrorMessage } from "@/components/clinicmind/patient-shared";

export interface FixedPatient {
  id: string;
  fullName: string;
  language?: string | null;
}

/** Copies text to the clipboard; falls back to a prompt-less toast when the API is unavailable (plain http). */
export function useCopy() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy(text: string, label = "Link copied") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast({ title: label, tone: "success" });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Could not copy", description: "Select the text and copy it manually.", tone: "danger" });
    }
  }
  return { copied, copy };
}

/** The one-time result of creating a link: URL with copy, QR code and the WhatsApp share. */
export function IntakeLinkResult({ issued }: { issued: IssuedIntakeLink }) {
  const { copied, copy } = useCopy();
  return (
    <div className="space-y-4">
      <Alert tone="info">This link is shown once. Copy it or save the QR now — it cannot be retrieved later.</Alert>
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        { }
        <img src={issued.qrDataUrl} alt="QR code for the onboarding link" width={160} height={160} className="h-40 w-40 shrink-0 rounded-md border border-border bg-white p-1" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="space-y-1.5">
            <span className="data-label">Link</span>
            <div className="flex gap-2">
              <Input readOnly value={issued.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" aria-label="Onboarding link" />
              <Button type="button" variant="outline" onClick={() => void copy(issued.url)} aria-label="Copy link">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={issued.whatsappUrl} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="h-4 w-4" />
                Share on WhatsApp
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={issued.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Open form
              </a>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {issued.link.kind === "PATIENT" ? `Pre-filled for ${issued.link.patient?.fullName ?? "the patient"}` : "Open link: anyone with it can fill the form"}
            {" · "}expires {new Date(issued.link.expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
            {issued.link.maxUses ? ` · up to ${issued.link.maxUses} ${issued.link.maxUses === 1 ? "use" : "uses"}` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * "New link" dialog. With `fixedPatient` it creates a PATIENT link pre-filled
 * for that patient (the patient page); otherwise reception picks the kind and,
 * for a patient link, the patient. After creation the dialog shows the result.
 */
export function NewIntakeLinkDialog({
  open,
  onOpenChange,
  fixedPatient,
  defaults,
  onIssued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fixedPatient?: FixedPatient | null;
  defaults?: { kind?: "OPEN" | "PATIENT"; label?: string; language?: "ar" | "en"; expiresInDays?: number; maxUses?: number | null; patient?: PatientOption | null };
  onIssued?: (issued: IssuedIntakeLink) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={fixedPatient ? `Send onboarding link · ${fixedPatient.fullName}` : "New onboarding link"}
        description={fixedPatient ? "A personal link, pre-filled with what the clinic already knows." : "A link the patient opens on their phone to fill the onboarding form."}
        className="max-h-[calc(100vh-2rem)] max-w-xl overflow-y-auto"
      >
        {open ? <NewIntakeLinkForm fixedPatient={fixedPatient} defaults={defaults} onIssued={onIssued} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function NewIntakeLinkForm({
  fixedPatient,
  defaults,
  onIssued,
  onClose,
}: {
  fixedPatient?: FixedPatient | null;
  defaults?: { kind?: "OPEN" | "PATIENT"; label?: string; language?: "ar" | "en"; expiresInDays?: number; maxUses?: number | null; patient?: PatientOption | null };
  onIssued?: (issued: IssuedIntakeLink) => void;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [kind, setKind] = useState<"OPEN" | "PATIENT">(fixedPatient ? "PATIENT" : (defaults?.kind ?? "OPEN"));
  const [patient, setPatient] = useState<PatientOption | null>(fixedPatient ? { id: fixedPatient.id, fullName: fixedPatient.fullName } : (defaults?.patient ?? null));
  const [language, setLanguage] = useState<"ar" | "en">(defaults?.language ?? (fixedPatient?.language === "en" ? "en" : "ar"));
  const [label, setLabel] = useState(defaults?.label ?? "");
  const [expiresInDays, setExpiresInDays] = useState(String(defaults?.expiresInDays ?? 14));
  const [maxUses, setMaxUses] = useState(defaults?.maxUses ? String(defaults.maxUses) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedIntakeLink | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (kind === "PATIENT" && !patient) {
      setErrors({ patientId: "Choose a patient." });
      return;
    }
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const result = await apiFetch<IssuedIntakeLink>("/api/intake/links", {
        method: "POST",
        body: {
          kind,
          patientId: kind === "PATIENT" ? patient?.id : undefined,
          language,
          label: label.trim() || undefined,
          expiresInDays: Number(expiresInDays) || 14,
          maxUses: maxUses.trim() ? Number(maxUses) : undefined,
        },
      });
      setIssued(result);
      onIssued?.(result);
      toast({ title: "Onboarding link created", description: result.link.label ?? (result.link.patient?.fullName ?? "Open link"), tone: "success" });
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (issued) {
    return (
      <div className="space-y-4">
        <IntakeLinkResult issued={issued} />
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const issue = (key: string) => (errors[key] ? <span className="text-danger">{errors[key]}</span> : undefined);

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error ? <Alert>{error}</Alert> : null}
      {!fixedPatient ? (
        <Field label="Kind" htmlFor={`${id}-kind`} hint={kind === "OPEN" ? "Anyone with the link can fill the form (desk QR, website)." : "Pre-filled for one patient; their phone match is automatic."}>
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as "OPEN" | "PATIENT")}>
            <option value="OPEN">Open link</option>
            <option value="PATIENT">Patient link</option>
          </Select>
        </Field>
      ) : null}
      {kind === "PATIENT" && !fixedPatient ? <PatientPicker value={patient} onChange={setPatient} error={errors.patientId} /> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Language" htmlFor={`${id}-lang`} hint={issue("language") ?? "The form opens in this language; the patient can switch."}>
          <Select id={`${id}-lang`} value={language} onChange={(e) => setLanguage(e.target.value as "ar" | "en")}>
            <option value="ar">Arabic</option>
            <option value="en">English</option>
          </Select>
        </Field>
        <Field label="Label" htmlFor={`${id}-label`} hint={issue("label") ?? "Optional · e.g. Reception desk QR"}>
          <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Expires in (days)" htmlFor={`${id}-expires`} hint={issue("expiresInDays") ?? "1–365 · default 14"}>
          <Input id={`${id}-expires`} type="number" min={1} max={365} value={expiresInDays} onChange={(e) => setExpiresInDays(e.target.value)} />
        </Field>
        <Field label="Maximum uses" htmlFor={`${id}-max`} hint={issue("maxUses") ?? "Optional · blank = unlimited"}>
          <Input id={`${id}-max`} type="number" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" />
        </Field>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          Create link
        </Button>
      </DialogFooter>
    </form>
  );
}
