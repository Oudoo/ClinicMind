"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, CheckCircle2, FilePlus2, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch } from "@/lib/http";
import { formatDateInTz } from "@/lib/time";
import type { ProtocolDTO, TreatmentProtocolsDTO } from "@/modules/concierge/dto";
import { dayLabel, protocolLengthDays, zSteps, type ProtocolStep } from "@/modules/concierge/protocols";
import { KIND_TEXT, stepTitle, viewLabel } from "@/modules/concierge/labels";
import { StepKindIcon } from "@/components/clinicmind/concierge-badges";
import { describeConciergeError } from "@/components/clinicmind/escalation-actions";
import { StepEditor, type StepErrors } from "@/components/clinicmind/protocol-step-editor";

/**
 * Protocols per treatment: the active version that new procedures are
 * enrolled in, a draft being prepared, and the retired ones. "New version"
 * copies the active one into a draft; the draft is edited step by step and a
 * clinician approves it (the previous version retires; running enrolments
 * keep theirs).
 */
export function ProtocolManager({
  treatments,
  timezone,
  canWrite,
  canApprove,
}: {
  treatments: TreatmentProtocolsDTO[];
  timezone: string;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<ProtocolDTO | null>(null);

  async function newVersion(treatmentId: string) {
    setBusy(treatmentId);
    try {
      const res = await apiFetch<{ protocol: ProtocolDTO }>("/api/concierge/protocols", { method: "POST", body: { treatmentId } });
      toast({ title: `Draft v${res.protocol.version} created`, description: "Edit the steps, then approve it.", tone: "success" });
      setEditing(res.protocol.id);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "draft_exists") {
        const draftId = (err.body as { protocolId?: string }).protocolId;
        if (draftId) setEditing(draftId);
      }
      toast({ title: "Could not create a new version", description: describeConciergeError(err), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  async function retire(p: ProtocolDTO) {
    setBusy(p.id);
    try {
      await apiFetch(`/api/concierge/protocols/${p.id}/retire`, { method: "POST" });
      toast({ title: `v${p.version} retired`, description: "New procedures of this treatment are not enrolled until a version is approved.", tone: "success" });
      setRetiring(null);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not retire", description: describeConciergeError(err), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  if (!treatments.length) {
    return (
      <Card>
        <EmptyState title="No treatments yet" hint="Protocols belong to the clinic's treatments." />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Every signed procedure is enrolled in the active version of its treatment. A new version starts as a copy; a doctor approves it and the previous one retires. Patients already
        enrolled keep the version they started with.
      </p>
      <ul className="space-y-4">
        {treatments.map((t) => {
          const draft = t.drafts[0] ?? null;
          const editingDraft = draft && editing === draft.id;
          return (
            <li key={t.treatment.id}>
              <Card className="space-y-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold tracking-tight">{t.treatment.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {t.active ? (
                        <>
                          <Badge tone="success">v{t.active.version} active</Badge>
                          <span>
                            {t.active.name} · {t.active.steps.length} steps over {protocolLengthDays(t.active.steps)} days · {t.active.enrolments} enrolled
                            {t.active.approvedAt ? ` · approved ${formatDateInTz(new Date(t.active.approvedAt), timezone)}` : ""}
                          </span>
                        </>
                      ) : (
                        <Badge tone="warning">No active version: new procedures are not enrolled</Badge>
                      )}
                      {draft ? <Badge tone="accent">v{draft.version} draft</Badge> : null}
                    </div>
                  </div>
                  {canWrite ? (
                    <div className="flex flex-wrap gap-2">
                      {draft ? (
                        !editingDraft ? (
                          <Button size="sm" onClick={() => setEditing(draft.id)}>
                            <Pencil className="h-4 w-4" />
                            Edit draft v{draft.version}
                          </Button>
                        ) : null
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => void newVersion(t.treatment.id)} disabled={busy === t.treatment.id}>
                          <FilePlus2 className="h-4 w-4" />
                          {busy === t.treatment.id ? "Copying…" : "New version"}
                        </Button>
                      )}
                      {t.active ? (
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRetiring(t.active)} disabled={busy === t.active.id}>
                          <Archive className="h-4 w-4" />
                          Retire v{t.active.version}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {editingDraft && draft ? (
                  <ProtocolEditor
                    key={draft.id}
                    protocol={draft}
                    previous={t.active}
                    canApprove={canApprove}
                    onClose={() => setEditing(null)}
                    onApproved={() => {
                      setEditing(null);
                      router.refresh();
                    }}
                  />
                ) : t.active ? (
                  <StepSummary steps={t.active.steps} />
                ) : draft ? (
                  <StepSummary steps={draft.steps} />
                ) : null}

                {t.retired.length ? (
                  <p className="text-xs text-muted-foreground">
                    Earlier:{" "}
                    {t.retired
                      .slice(0, 5)
                      .map((r) => `v${r.version}${r.retiredAt ? ` retired ${formatDateInTz(new Date(r.retiredAt), timezone)}` : ""}${r.enrolments ? ` (${r.enrolments} enrolled)` : ""}`)
                      .join(" · ")}
                  </p>
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={retiring !== null}
        onOpenChange={(open) => !open && setRetiring(null)}
        title={retiring ? `Retire v${retiring.version}?` : "Retire"}
        description="Patients already enrolled keep it. Newly signed procedures of this treatment are not enrolled until another version is approved."
        confirmLabel="Retire"
        tone="danger"
        busy={busy !== null}
        onConfirm={() => (retiring ? retire(retiring) : undefined)}
      />
    </div>
  );
}

function StepSummary({ steps }: { steps: ProtocolStep[] }) {
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {steps.map((s, i) => {
        const redFlags = (s.questions ?? []).filter((q) => q.highRisk || q.danger).length;
        return (
          <li key={i} className="flex items-start gap-2 rounded-md border border-border p-2.5">
            <StepKindIcon kind={s.kind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{stepTitle(dayLabel(s), s.title)}</p>
              <p className="text-xs text-muted-foreground">
                {s.kind === "CHECK_IN"
                  ? `${s.questions?.length ?? 0} question${s.questions?.length === 1 ? "" : "s"}${redFlags ? ` · ${redFlags} red flag${redFlags === 1 ? "" : "s"}` : ""}${s.satisfaction ? " · satisfaction" : ""}`
                  : s.kind === "PHOTO_REQUEST"
                    ? (s.photos ?? []).map((v) => viewLabel(v)).join(", ")
                    : KIND_TEXT[s.kind]}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Zod issues of the steps → messages per step, keyed by the path inside the step. */
function stepErrors(steps: ProtocolStep[]): { byStep: StepErrors[]; count: number } {
  const parsed = zSteps.safeParse(steps);
  const byStep: StepErrors[] = steps.map(() => ({}));
  if (parsed.success) return { byStep, count: 0 };
  for (const issue of parsed.error.issues) {
    const [index, ...rest] = issue.path;
    if (typeof index !== "number" || !byStep[index]) continue;
    const key = rest.join(".") || "title";
    byStep[index]![key] ??= issue.message;
  }
  return { byStep, count: parsed.error.issues.length };
}

function ProtocolEditor({
  protocol,
  previous,
  canApprove,
  onClose,
  onApproved,
}: {
  protocol: ProtocolDTO;
  previous: ProtocolDTO | null;
  canApprove: boolean;
  onClose: () => void;
  onApproved: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(protocol.name);
  const [notes, setNotes] = useState(protocol.notes ?? "");
  const [steps, setSteps] = useState<ProtocolStep[]>(protocol.steps);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const validation = useMemo(() => stepErrors(steps), [steps]);

  const update = (next: ProtocolStep[]) => {
    setSteps(next);
    setDirty(true);
  };

  async function save(): Promise<boolean> {
    setShowErrors(true);
    if (validation.count) {
      setError(`Fix the ${validation.count} highlighted problem${validation.count === 1 ? "" : "s"} first.`);
      return false;
    }
    if (!name.trim()) {
      setError("Give the protocol a name.");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      // Steps go in time order, so the patient's timeline reads top to bottom.
      const ordered = steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.offsetHours - b.s.offsetHours || a.i - b.i).map((x) => x.s);
      await apiFetch(`/api/concierge/protocols/${protocol.id}`, { method: "PATCH", body: { name: name.trim(), notes, steps: ordered } });
      setSteps(ordered);
      setDirty(false);
      return true;
    } catch (err) {
      setError(describeConciergeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (dirty && !(await save())) {
      setApproving(false);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/concierge/protocols/${protocol.id}/approve`, { method: "POST" });
      toast({ title: `v${protocol.version} approved`, description: previous ? `v${previous.version} retired; new procedures get v${protocol.version}.` : "New procedures are enrolled in it.", tone: "success" });
      onApproved();
    } catch (err) {
      setError(describeConciergeError(err));
    } finally {
      setBusy(false);
      setApproving(false);
    }
  }

  async function discard() {
    setBusy(true);
    try {
      await apiFetch(`/api/concierge/protocols/${protocol.id}`, { method: "DELETE" });
      toast({ title: `Draft v${protocol.version} discarded`, tone: "success" });
      onApproved();
    } catch (err) {
      setError(describeConciergeError(err));
    } finally {
      setBusy(false);
      setDiscarding(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-accent/30 bg-accent-muted/30 p-3 sm:p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr]">
        <Field label={`Draft v${protocol.version} · name`} htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} value={name} onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }} maxLength={120} disabled={busy} />
        </Field>
        <Field label="What changed (notes)" htmlFor={`${id}-notes`}>
          <Textarea id={`${id}-notes`} value={notes} onChange={(e) => {
              setNotes(e.target.value);
              setDirty(true);
            }} maxLength={2000} className="min-h-[2.5rem]" rows={1} disabled={busy} />
        </Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <StepEditor
            key={i}
            step={step}
            index={i}
            count={steps.length}
            errors={showErrors ? (validation.byStep[i] ?? {}) : {}}
            disabled={busy}
            onChange={(next) => update(steps.map((s, j) => (j === i ? next : s)))}
            onMove={(delta) => {
              const j = i + delta;
              if (j < 0 || j >= steps.length) return;
              const next = [...steps];
              [next[i], next[j]] = [next[j]!, next[i]!];
              update(next);
            }}
            onRemove={() => update(steps.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || steps.length >= 40}
          onClick={() => {
            const last = steps.reduce((m, s) => Math.max(m, s.offsetHours), 0);
            update([...steps, { offsetHours: last + 24, kind: "CHECK_IN", title: "New check-in", body: { ar: "", en: "" }, questions: [], satisfaction: true }]);
          }}
        >
          <Plus className="h-4 w-4" />
          Add step
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="ghost" className="text-danger" onClick={() => setDiscarding(true)} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            Discard
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            <X className="h-4 w-4" />
            Close
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !dirty}
            onClick={() =>
              void save().then((ok) => {
                if (ok) {
                  toast({ title: "Draft saved", tone: "success" });
                  router.refresh();
                }
              })
            }
          >
            <Save className="h-4 w-4" />
            {busy ? "Saving…" : dirty ? "Save draft" : "Saved"}
          </Button>
          {canApprove ? (
            <Button type="button" size="sm" onClick={() => setApproving(true)} disabled={busy || !steps.length}>
              <CheckCircle2 className="h-4 w-4" />
              Approve v{protocol.version}
            </Button>
          ) : (
            <span className="self-center text-xs text-muted-foreground">A doctor or the owner approves drafts.</span>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={approving}
        onOpenChange={setApproving}
        title={`Approve v${protocol.version}?`}
        description={`It becomes the protocol for every newly signed procedure${previous ? `; v${previous.version} retires` : ""}. Patients already enrolled keep their version.${dirty ? " Your unsaved edits are saved first." : ""}`}
        confirmLabel="Approve"
        busy={busy}
        onConfirm={approve}
      />
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={`Discard draft v${protocol.version}?`}
        description="The draft and its edits are thrown away. The active version is not touched."
        confirmLabel="Discard draft"
        tone="danger"
        busy={busy}
        onConfirm={discard}
      />
    </div>
  );
}
