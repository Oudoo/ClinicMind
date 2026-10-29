"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { addDays, dateKeyInTz, formatDateInTz, formatTimeInTz, fromDateKey } from "@/lib/time";
import { CHANNEL_LABEL, OWNER_ROLE_LABEL, RECALL_CHANNELS, RECALL_OWNER_ROLES } from "@/modules/recalls/constants";
import type { RecallDTO } from "@/modules/recalls/dto";
import { RecallActions } from "./recall-actions";
import { RecallLog } from "./recall-list";
import { BandBadge, egp, recallErrorMessage } from "./recall-shared";

const day = (iso: string, timezone: string) => formatDateInTz(new Date(iso), timezone, { day: "numeric", month: "short" });

/**
 * The recalls card on a patient's record: each one still being worked (how
 * urgent, the window, where it stands, the desk's actions and its log), the
 * last ones ended, and "Add" for a review the doctor asked for that no rule
 * makes.
 */
export function PatientRecallPanel({
  patientId,
  active,
  closed,
  timezone,
  canWrite,
}: {
  patientId: string;
  active: RecallDTO[];
  closed: RecallDTO[];
  timezone: string;
  canWrite: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const name = (active[0] ?? closed[0])?.patient.fullName;
  return (
    <Card className="space-y-3" id="recalls">
      <SectionTitle
        title="Recalls"
        description="When the patient is due back, and what the desk did about it."
        action={
          canWrite ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add
            </Button>
          ) : null
        }
      />
      {active.length ? (
        <ul className="divide-y divide-border" aria-label="This patient's recalls">
          {active.map((r) => (
            <PanelRow key={r.id} recall={r} timezone={timezone} canWrite={canWrite} />
          ))}
        </ul>
      ) : (
        <EmptyState title="Not due back for anything" hint="Signed procedures, a course's sessions and the doctor's follow-ups bring recalls here." />
      )}
      {closed.length ? (
        <div>
          <p className="data-label">Ended</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground" aria-label="Recalls ended">
            {closed.map((r) => (
              <li key={r.id}>
                <span className="text-foreground">{r.label}</span> · {r.statusLabel}
                {r.declineLabel ? ` (${r.declineLabel.toLowerCase()})` : ""}
                {r.closedAt ? ` · ${day(r.closedAt, timezone)}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {name ? (
        <Link href={`/dashboard/recalls?tab=all&q=${encodeURIComponent(name)}`} className="inline-block text-xs font-medium text-accent hover:underline">
          In the recall list
        </Link>
      ) : null}
      {adding ? <AddRecallDialog patientId={patientId} timezone={timezone} onClose={() => setAdding(false)} /> : null}
    </Card>
  );
}

function PanelRow({ recall: r, timezone, canWrite }: { recall: RecallDTO; timezone: string; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const booked = r.booked ? new Date(r.booked.startsAt) : null;
  return (
    <li className="space-y-1.5 py-3 first:pt-0 last:pb-0">
      <p className="text-sm font-medium">{r.label}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <BandBadge recall={r} />
        <Badge>{r.kindLabel}</Badge>
        {r.value > 0 ? <span className="font-mono text-xs tabular-nums text-muted-foreground">{egp(r.value)}</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Due {day(r.dueAt, timezone)} – {day(r.windowEndAt, timezone)} · {r.statusLabel}
        {r.attempts ? ` · ${r.attempts} tr${r.attempts === 1 ? "y" : "ies"}` : ""}
        {booked ? ` · ${formatDateInTz(booked, timezone, { weekday: "short", day: "numeric", month: "short" })} ${formatTimeInTz(booked, timezone)}${r.booked?.doctorName ? ` with ${r.booked.doctorName}` : ""}` : ""}
        {r.status === "SNOOZED" && r.snoozedUntil ? ` · until ${day(r.snoozedUntil, timezone)}` : ""}
      </p>
      {r.hint ? <p className="text-xs text-warning">{r.hint}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {canWrite ? <RecallActions recall={r} timezone={timezone} className="contents" /> : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} the log of "${r.label}"`}
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Log
          {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </div>
      {open ? <RecallLog recallId={r.id} timezone={timezone} /> : null}
    </li>
  );
}

/** A review no rule makes ("see her again after the exams"), by hand. */
function AddRecallDialog({ patientId, timezone, onClose }: { patientId: string; timezone: string; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [label, setLabel] = useState("");
  const [dueOn, setDueOn] = useState(() => dateKeyInTz(addDays(new Date(), 28, timezone), timezone));
  const [windowDays, setWindowDays] = useState("7");
  const [channel, setChannel] = useState<string>("WHATSAPP");
  const [ownerRole, setOwnerRole] = useState<string>("RECEPTIONIST");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await apiFetch("/api/recalls", { method: "POST", body: { patientId, label, dueOn, windowDays: Number(windowDays) || 0, channel, ownerRole, ...(note.trim() ? { note } : {}) } });
      const due = fromDateKey(dueOn, timezone);
      toast({ title: "Recall added", description: due ? `${label} · due ${formatDateInTz(due, timezone, { day: "numeric", month: "short" })}` : label, tone: "success" });
      onClose();
      router.refresh();
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
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent title="Add a recall" description="For a review no rule makes. The desk sees it on its list when it is due.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Due back for" htmlFor={`${id}-label`} hint={hint("label", "What the patient comes back for")}>
            <Input id={`${id}-label`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="Melasma check after the summer" aria-invalid={issues.label ? true : undefined} />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Due on" htmlFor={`${id}-due`} hint={hint("dueOn")}>
              <Input id={`${id}-due`} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} aria-invalid={issues.dueOn ? true : undefined} />
            </Field>
            <Field label="On time for (days)" htmlFor={`${id}-window`} hint={hint("windowDays", "After the due day")}>
              <Input id={`${id}-window`} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} inputMode="numeric" aria-invalid={issues.windowDays ? true : undefined} />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Reached by" htmlFor={`${id}-channel`}>
              <Select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value)}>
                {RECALL_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Worked by" htmlFor={`${id}-role`}>
              <Select id={`${id}-role`} value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
                {RECALL_OWNER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {OWNER_ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Note" htmlFor={`${id}-note`} hint={hint("note", "Optional; on the recall's log")}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || label.trim().length < 2}>
              {busy ? "Adding…" : "Add recall"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
