"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { AppointmentStatusBadge } from "@/components/clinicmind/appointment-status";
import type { AppointmentStatus } from "@/modules/appointments/transitions";

/** The steps a visit takes, with the one-tap button the desk sees at each. */
const STEPS: { status: AppointmentStatus; action: string | null }[] = [
  { status: "SCHEDULED", action: "Confirm" },
  { status: "CONFIRMED", action: "Check in" },
  { status: "CHECKED_IN", action: "Start consultation" },
  { status: "IN_PROGRESS", action: "Complete" },
  { status: "COMPLETED", action: null },
];

const row = "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4";
const time = "w-24 shrink-0 whitespace-nowrap text-sm font-medium tabular-nums";
const fakeButton = "inline-flex h-8 items-center whitespace-nowrap rounded-lg border border-border bg-card px-3 text-sm font-medium";

/**
 * The home page's first proof: three lines of the day's list as the desk sees them. The first
 * visit moves through its steps (booked, confirmed, checked in, in consultation, done) unless
 * the visitor asked for less motion, in which case it rests on "checked in". A picture of the
 * product, not a control: it is inert and described by its label.
 */
export function VisitJourney() {
  const [step, setStep] = useState(2);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setStep((s) => (s + 1) % STEPS.length), 2400);
    return () => window.clearInterval(timer);
  }, []);
  const current = STEPS[step]!;

  return (
    <div
      role="img"
      aria-label="The day's list: Sherif Nabil's visit moving from booked to confirmed, checked in, in consultation and done; Karim Hamdy checked in and late; Mahmoud Zaki in consultation."
      className="bento overflow-hidden p-0"
    >
      <div inert className="divide-y divide-border">
        <p className="px-4 py-2.5 text-sm text-muted-foreground">2 waiting in the clinic · 1 in consultation · 5 to come</p>
        {/* The marks and the button drop under the name when the line is short of room, as in the product. */}
        <div className={`${row} sm:flex-wrap`}>
          <span className={time}>
            10:00<span className="font-normal text-muted-foreground">–10:20</span>
          </span>
          <div className="min-w-0 flex-1 sm:min-w-[14rem]">
            <p className="truncate text-sm font-medium">Sherif Nabil</p>
            <p className="truncate text-xs text-muted-foreground">Psoriasis consultation · Dr. Mariam Tarek · Room 2</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:ms-auto sm:justify-end">
            <Badge tone="warning">Owes 1,100 EGP</Badge>
            <AppointmentStatusBadge status={current.status} />
            {/* The width is kept when the visit is done, so the line does not jump. */}
            <span className={fakeButton} style={current.action ? undefined : { visibility: "hidden" }}>
              {current.action ?? "Complete"}
            </span>
          </div>
        </div>
        <div className={row}>
          <span className={time}>
            10:30<span className="font-normal text-muted-foreground">–11:00</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Karim Hamdy</p>
            <p className="truncate text-xs text-muted-foreground">Wart cryotherapy · Dr. Layla Hassan · Laser suite</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            <Badge tone="danger" className="gap-1">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              Late
            </Badge>
            <AppointmentStatusBadge status="CHECKED_IN" />
          </div>
        </div>
        <div className={row}>
          <span className={time}>
            11:00<span className="font-normal text-muted-foreground">–11:30</span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">Mahmoud Zaki</p>
            <p className="truncate text-xs text-muted-foreground">Eczema flare · Dr. Mariam Tarek · Procedure room</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            <AppointmentStatusBadge status="IN_PROGRESS" />
          </div>
        </div>
      </div>
    </div>
  );
}
