"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Moon, Save, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { ApiError, apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { ConciergeSettingsDTO, OnCallDTO, RosterUserDTO } from "@/modules/concierge/dto";
import { WEEKDAY_ORDER, WEEKDAY_SHORT } from "@/modules/concierge/labels";
import { describeConciergeError } from "@/components/clinicmind/escalation-actions";

type Effective = { fullName: string; isDefault: boolean } | null;

const ROLE_TEXT: Record<string, string> = { CLINIC_OWNER: "Owner", DOCTOR: "Doctor", NURSE: "Nurse" };
const IN_HOURS_MINUTES = [5, 10, 15, 20, 30];
const OUT_OF_HOURS_MINUTES = [15, 20, 30, 45, 60];

/**
 * Roster & hours: the clinic's open days and hours on the clinic clock, who a
 * high-risk reply reaches in hours and out of hours, the backup who hears
 * about everything, and the acknowledgement targets (15 / 30 minutes per the
 * spec). The owner edits it; everyone else sees it.
 */
export function ConciergeSettingsForm({
  initial,
  candidates,
  effective,
  onCall,
  timezone,
  canEdit,
}: {
  initial: ConciergeSettingsDTO;
  candidates: RosterUserDTO[];
  effective: { inHours: Effective; outOfHours: Effective; backup: Effective };
  onCall: OnCallDTO;
  timezone: string;
  canEdit: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [days, setDays] = useState<number[]>(initial.hours.days);
  const [start, setStart] = useState(initial.hours.start);
  const [end, setEnd] = useState(initial.hours.end);
  const [roster, setRoster] = useState(initial.roster);
  const [ack, setAck] = useState(initial.ackMinutes);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleDay = (d: number) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d].sort()));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await apiFetch("/api/concierge/settings", {
        method: "PUT",
        body: { hours: { days, start, end }, roster, ackMinutes: ack },
      });
      toast({ title: "Roster and hours saved", description: "New escalations follow it from now on.", tone: "success" });
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setErrors(fieldErrors(err));
      setError(describeConciergeError(err));
    } finally {
      setBusy(false);
    }
  }

  const options = (
    <>
      {candidates.map((c) => (
        <option key={c.id} value={c.id}>
          {c.fullName} · {ROLE_TEXT[c.role] ?? c.role}
        </option>
      ))}
    </>
  );
  const slot = (key: "inHoursUserId" | "outOfHoursUserId" | "backupUserId", label: string, hint: string, now: Effective) => (
    <Field
      label={label}
      htmlFor={`${id}-${key}`}
      hint={
        errors[key] ? (
          <span className="text-danger">{errors[key]}</span>
        ) : (
          <>
            {hint}
            {now ? (
              <>
                {" "}
                · today: <span className="font-medium text-foreground">{now.fullName}</span>
                {now.isDefault ? " (default by role)" : ""}
              </>
            ) : null}
          </>
        )
      }
    >
      <Select
        id={`${id}-${key}`}
        value={roster[key] ?? ""}
        onChange={(e) => setRoster((r) => ({ ...r, [key]: e.target.value || null }))}
        disabled={!canEdit || busy}
        aria-invalid={errors[key] ? true : undefined}
      >
        <option value="">Default by role</option>
        {options}
      </Select>
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-3 sm:p-5">
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", onCall.outOfHours ? "bg-muted" : "bg-accent-muted text-accent")}>
          {onCall.outOfHours ? <Moon className="h-4 w-4" aria-hidden="true" /> : <Sun className="h-4 w-4" aria-hidden="true" />}
        </span>
        <p className="text-sm">
          Right now ({onCall.outOfHours ? "out of hours" : "in hours"}, {timezone.replace("_", " ")}): a high-risk reply goes to{" "}
          <span className="font-medium">{onCall.assigneeName ?? "nobody"}</span> with <span className="font-medium">{onCall.ackMinutes} minutes</span> to acknowledge
          {onCall.backupName ? `, backup ${onCall.backupName}` : ""}. Past the target, they, the backup and the owner are told again every 30 minutes.
        </p>
      </Card>

      {!canEdit ? <Alert tone="info">Only the clinic owner changes the roster and hours.</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <div>
            <h3 className="font-display text-base font-semibold tracking-tight">Clinic hours</h3>
            <p className="text-sm text-muted-foreground">Inside these hours the in-hours person and target apply; outside them, the out-of-hours ones.</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="data-label">Open days</legend>
            <div className="flex flex-wrap gap-2">
              {WEEKDAY_ORDER.map((d) => {
                const on = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    disabled={!canEdit || busy}
                    onClick={() => toggleDay(d)}
                    className={cn(
                      "h-10 min-w-[3.25rem] rounded-lg border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed",
                      on ? "border-accent bg-accent-muted text-accent" : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {WEEKDAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
            {errors.hours ? <p className="text-xs text-danger">{errors.hours}</p> : null}
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Opens" htmlFor={`${id}-start`}>
              <Input id={`${id}-start`} type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!canEdit || busy} required />
            </Field>
            <Field label="Closes" htmlFor={`${id}-end`} hint={end <= start ? "Overnight: closes the next morning" : undefined}>
              <Input id={`${id}-end`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!canEdit || busy} required />
            </Field>
          </div>
        </Card>

        <Card className="space-y-4">
          <div>
            <h3 className="font-display text-base font-semibold tracking-tight">Who takes a high-risk reply</h3>
            <p className="text-sm text-muted-foreground">Owners, doctors and nurses of the clinic. Left on the default, it is the first nurse in hours and the first doctor out of hours.</p>
          </div>
          {slot("inHoursUserId", "In hours", "Assigned during clinic hours", effective.inHours)}
          {slot("outOfHoursUserId", "Out of hours", "Assigned outside clinic hours", effective.outOfHours)}
          {slot("backupUserId", "Backup", "Told about every escalation, and again when one is overdue", effective.backup)}
        </Card>
      </div>

      <Card className="space-y-4">
        <div>
          <h3 className="font-display text-base font-semibold tracking-tight">Acknowledgement targets</h3>
          <p className="text-sm text-muted-foreground">
            The board counts down to these and the KPI measures them. Out-of-range answers that are not high-risk (watch) get four hours.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="In hours" htmlFor={`${id}-ackIn`} hint="Spec: 15 minutes">
            <Select id={`${id}-ackIn`} value={ack.inHours} onChange={(e) => setAck((a) => ({ ...a, inHours: Number(e.target.value) }))} disabled={!canEdit || busy}>
              {[...new Set([...IN_HOURS_MINUTES, ack.inHours])].sort((x, y) => x - y).map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Out of hours" htmlFor={`${id}-ackOut`} hint="Spec: 30 minutes">
            <Select id={`${id}-ackOut`} value={ack.outOfHours} onChange={(e) => setAck((a) => ({ ...a, outOfHours: Number(e.target.value) }))} disabled={!canEdit || busy}>
              {[...new Set([...OUT_OF_HOURS_MINUTES, ack.outOfHours])].sort((x, y) => x - y).map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Days on: {days.length ? WEEKDAY_ORDER.filter((d) => days.includes(d)).map((d) => WEEKDAY_SHORT[d]).join(", ") : <Badge tone="warning">none: always out of hours</Badge>}
            </p>
            <Button type="submit" disabled={busy}>
              <Save className="h-4 w-4" />
              {busy ? "Saving…" : "Save roster & hours"}
            </Button>
          </div>
        ) : null}
      </Card>
    </form>
  );
}
