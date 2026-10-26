"use client";

import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeTarget } from "@/modules/concierge/labels";

/**
 * The server's clock on this device: starts at the server's `now` (so the
 * first render matches the server's markup), then ticks with the device's
 * clock corrected by the difference measured when `serverNow` arrived.
 */
export function useServerClock(serverNow: string, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.parse(serverNow));
  useEffect(() => {
    const skew = Date.parse(serverNow) - Date.now();
    const tick = () => setNow(Date.now() + skew);
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, everyMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [serverNow, everyMs]);
  return now;
}

/** "12:04 left", then "3:10 overdue" in red; longer spans as "2 h 05 min left". */
export function CountdownText({ dueAt, now, className }: { dueAt: string; now: number; className?: string }) {
  const r = relativeTarget(dueAt, now);
  const total = Math.floor(Math.abs(r.minutes) * 60);
  const urgent = !r.overdue && r.minutes < 5;
  const short = total < 3600 ? `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} ${r.overdue ? "overdue" : "left"}` : r.text;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums",
        r.overdue ? "font-semibold text-danger" : urgent ? "text-warning" : "text-muted-foreground",
        className,
      )}
      role="timer"
      aria-live="off"
    >
      <Timer className="h-3.5 w-3.5" aria-hidden="true" />
      {short}
    </span>
  );
}

/** A self-ticking countdown, for pages that show one or two targets. */
export function Countdown({ dueAt, serverNow, className }: { dueAt: string; serverNow: string; className?: string }) {
  const now = useServerClock(serverNow);
  return <CountdownText dueAt={dueAt} now={now} className={className} />;
}
