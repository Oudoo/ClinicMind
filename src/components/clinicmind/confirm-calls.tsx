"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { dateKeyInTz, formatDateInTz, formatTimeInTz } from "@/lib/time";
import type { ToConfirmRow } from "@/modules/appointments/reminders";
import { recallErrorMessage } from "./recall-shared";

/**
 * Bookings reception calls about: the next open day's visits still unconfirmed the
 * day before (flagged from the clinic's chosen time), and patients who
 * answered a reminder or a moved time with 2 (another time). "Confirmed"
 * after the call; "Move" opens the day to rebook it.
 */
export function ConfirmCalls({ rows, timezone, canWrite }: { rows: ToConfirmRow[]; timezone: string; canWrite: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function confirm(row: ToConfirmRow) {
    setBusy(row.id);
    try {
      await apiFetch(`/api/appointments/${row.id}/transition`, { method: "POST", body: { status: "CONFIRMED" } });
      toast({ title: `${row.patient.fullName} confirmed`, description: `${formatDateInTz(new Date(row.startsAt), timezone, { weekday: "short", day: "numeric", month: "short" })} ${formatTimeInTz(new Date(row.startsAt), timezone)}`, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not confirm the visit", description: recallErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3 p-0" id="confirm">
      <div className="px-4 pt-4 sm:px-5">
        <SectionTitle title="Call about bookings" description="Visits on the next open day not confirmed yet, and patients who asked for another time." action={<Badge tone="warning">{rows.length}</Badge>} />
      </div>
      <ul className="divide-y divide-border" aria-label="Bookings to call about">
        {rows.map((r) => {
          const at = new Date(r.startsAt);
          return (
            <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-mono tabular-nums">{formatDateInTz(at, timezone, { weekday: "short", day: "numeric", month: "short" })} {formatTimeInTz(at, timezone)}</span>
                  {" · "}
                  <Link href={`/dashboard/patients/${r.patient.id}?tab=overview`} className="font-medium hover:underline">
                    {r.patient.fullName}
                  </Link>
                  {r.doctorName ? <span className="text-muted-foreground"> · {r.doctorName}</span> : null}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Badge tone={r.reason === "reschedule" ? "danger" : "warning"}>{r.reason === "reschedule" ? "Asked for another time" : "Not confirmed"}</Badge>
                  {r.patient.phone ? (
                    <a href={`tel:${r.patient.phone}`} className="font-mono text-xs text-muted-foreground hover:text-foreground">
                      {r.patient.phone}
                    </a>
                  ) : null}
                </div>
              </div>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {r.status === "SCHEDULED" && r.reason === "unconfirmed" ? (
                    <Button size="sm" variant="outline" onClick={() => void confirm(r)} disabled={busy === r.id} aria-label={`${r.patient.fullName} confirmed on the phone`}>
                      <CheckCheck className="h-4 w-4" aria-hidden="true" />
                      {busy === r.id ? "Saving…" : "Confirmed"}
                    </Button>
                  ) : null}
                  <Button size="sm" variant={r.reason === "reschedule" ? "primary" : "ghost"} asChild>
                    <Link href={`/dashboard/appointments?date=${dateKeyInTz(at, timezone)}&view=day`} aria-label={`Move ${r.patient.fullName}'s visit`}>
                      <CalendarClock className="h-4 w-4" aria-hidden="true" />
                      Move
                    </Link>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
