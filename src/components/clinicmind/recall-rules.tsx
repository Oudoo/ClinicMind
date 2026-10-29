"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { CHANNEL_LABEL, OWNER_ROLE_LABEL, RECALL_CHANNELS, RECALL_OWNER_ROLES } from "@/modules/recalls/constants";
import type { RecallRuleDTO } from "@/modules/recalls/dto";
import { recallErrorMessage } from "./recall-shared";

/** "30 days (1 month)", "42 days (6 weeks)". */
function daysPhrase(days: number): string {
  const months = days / 30.44;
  if (days >= 28 && Math.abs(months - Math.round(months)) * 30.44 <= 3) return `${days} days (${Math.round(months)} month${Math.round(months) === 1 ? "" : "s"})`;
  if (days % 7 === 0) return `${days} days (${days / 7} week${days === 7 ? "" : "s"})`;
  return `${days} days`;
}

function ruleSummary(r: RecallRuleDTO): string {
  if (r.kind === "SESSIONS") {
    const every = r.dueDays[0] ?? 0;
    return `Next session ${daysPhrase(every)} after each, on time for ${r.windowDays} more days${r.sessions ? ` · ${r.sessions} sessions when recorded one at a time` : ""}`;
  }
  return `Reviews at ${r.dueDays.map(daysPhrase).join(", ")} · each on time for ${r.windowDays} days`;
}

/**
 * The clinic's recall rules: what brings a patient back and when, who works
 * the recall and how the patient is reached. The owner edits them; a change
 * applies to the recalls made from then on.
 */
export function RecallRules({ rules, treatments, staff, canManage }: { rules: RecallRuleDTO[]; treatments: { id: string; name: string }[]; staff: { id: string; name: string }[]; canManage: boolean }) {
  const [editing, setEditing] = useState<RecallRuleDTO | "new" | null>(null);
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          A procedure of the rule's treatment, or a signed consultation whose diagnosis contains one of its words, makes the recalls. A course (work sold in sessions) always recalls its next session: at the treatment's session rule, otherwise four weeks.
        </p>
        {canManage ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New rule
          </Button>
        ) : null}
      </div>
      {rules.length ? (
        <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {rules.map((r) => (
            <li key={r.id}>
              <Card className="h-full space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.treatment ? r.treatment.name : "Any treatment"}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {r.active ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
                    {canManage ? (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="text-sm">{ruleSummary(r)}</p>
                {r.diagnosisTerms.length ? (
                  <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    Diagnoses containing
                    {r.diagnosisTerms.map((t) => (
                      <span key={t} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                        {t}
                      </span>
                    ))}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {r.owner ? r.owner.name : OWNER_ROLE_LABEL[r.ownerRole]} · {CHANNEL_LABEL[r.channel]} · {r.openRecalls} open
                </p>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <Card>
          <EmptyState title="No recall rules yet" hint="The clinic's four starting rules appear the first time a procedure is signed." />
        </Card>
      )}
      {editing ? (
        <RuleDialog
          rule={editing === "new" ? null : editing}
          treatments={treatments}
          staff={staff}
          onOpenChange={(o) => !o && setEditing(null)}
          onDone={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

const parseDays = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number);

function RuleDialog({ rule, treatments, staff, onOpenChange, onDone }: { rule: RecallRuleDTO | null; treatments: { id: string; name: string }[]; staff: { id: string; name: string }[]; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const { toast } = useToast();
  const [name, setName] = useState(rule?.name ?? "");
  const [kind, setKind] = useState<"SESSIONS" | "REVIEWS">(rule?.kind ?? "REVIEWS");
  const [treatmentId, setTreatmentId] = useState(rule?.treatment?.id ?? "");
  const [terms, setTerms] = useState((rule?.diagnosisTerms ?? []).join(", "));
  const [days, setDays] = useState((rule?.dueDays ?? []).join(", "));
  const [windowDays, setWindowDays] = useState(String(rule?.windowDays ?? 14));
  const [sessions, setSessions] = useState(rule?.sessions ? String(rule.sessions) : "");
  const [ownerRole, setOwnerRole] = useState<string>(rule?.ownerRole ?? "RECEPTIONIST");
  const [ownerId, setOwnerId] = useState(rule?.owner?.id ?? "");
  const [channel, setChannel] = useState<string>(rule?.channel ?? "WHATSAPP");
  const [active, setActive] = useState(rule?.active ?? true);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const dueDays = parseDays(days);
    if (!dueDays.length || dueDays.some((d) => !Number.isInteger(d) || d < 1)) return setIssues({ dueDays: kind === "SESSIONS" ? "Days between sessions, e.g. 28" : "Days after the treatment, e.g. 30, 91, 182" });
    setBusy(true);
    setError(null);
    const body = {
      name,
      kind,
      treatmentId: treatmentId || null,
      diagnosisTerms: terms.split(",").map((t) => t.trim()).filter(Boolean),
      dueDays,
      windowDays: Number(windowDays) || 0,
      sessions: kind === "SESSIONS" && sessions ? Number(sessions) : null,
      ownerRole,
      ownerId: ownerId || null,
      channel,
      active,
    };
    try {
      await apiFetch(rule ? `/api/recall-rules/${rule.id}` : "/api/recall-rules", { method: rule ? "PATCH" : "POST", body });
      toast({ title: rule ? "Rule saved" : "Rule added", description: "It applies to the recalls made from now on.", tone: "success" });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : recallErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={rule ? `Edit "${rule.name}"` : "New recall rule"} description="Recalls already made keep their dates." className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`} hint={hint("name")}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Botox top-up at 4 months" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Brings the patient back for" htmlFor={`${id}-kind`}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as "SESSIONS" | "REVIEWS")}>
                <option value="REVIEWS">Reviews at set days</option>
                <option value="SESSIONS">The next session of a course</option>
              </Select>
            </Field>
            <Field label="Treatment" htmlFor={`${id}-treatment`} hint={hint("treatmentId", kind === "SESSIONS" ? "Required for a course" : "Or diagnosis words below")}>
              <Select id={`${id}-treatment`} value={treatmentId} onChange={(e) => setTreatmentId(e.target.value)} aria-invalid={issues.treatmentId ? true : undefined}>
                <option value="">None (diagnosis words only)</option>
                {treatments.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Diagnosis words" htmlFor={`${id}-terms`} hint={hint("diagnosisTerms", "A signed diagnosis containing one of them triggers it; separate with commas")}>
            <Input id={`${id}-terms`} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="acne, حب الشباب" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={kind === "SESSIONS" ? "Days between sessions" : "Review days"} htmlFor={`${id}-days`} hint={hint("dueDays", kind === "SESSIONS" ? "e.g. 28" : "e.g. 30, 91, 182, 365")}>
              <Input id={`${id}-days`} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" aria-invalid={issues.dueDays ? true : undefined} />
            </Field>
            <Field label="On time for (days)" htmlFor={`${id}-window`} hint={hint("windowDays", "After the due day")}>
              <Input id={`${id}-window`} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} inputMode="numeric" />
            </Field>
            {kind === "SESSIONS" ? (
              <Field label="Sessions" htmlFor={`${id}-sessions`} hint={hint("sessions", "When each is its own procedure")}>
                <Input id={`${id}-sessions`} value={sessions} onChange={(e) => setSessions(e.target.value)} inputMode="numeric" placeholder="6" />
              </Field>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Worked by" htmlFor={`${id}-role`}>
              <Select id={`${id}-role`} value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
                {RECALL_OWNER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {OWNER_ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Or one person" htmlFor={`${id}-owner`} hint="Optional">
              <Select id={`${id}-owner`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Anyone in the role</option>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reached by" htmlFor={`${id}-channel`}>
              <Select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {RECALL_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onChange={(e) => setActive(e.target.checked)} />
            On: makes recalls
          </label>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : rule ? "Save the rule" : "Add the rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
