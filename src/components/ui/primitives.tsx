import * as React from "react";
import { cn } from "@/lib/utils";

/** A grid of equal tiles, for content that really is a set of equals (never as a page's structure). */
export function Bento({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4", className)}
      {...props}
    />
  );
}

/** One bordered surface for content that belongs together. Do not put a card inside a card: divide it with rules instead. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("bento", className)} {...props} />;
}

export type Tone = "default" | "accent" | "success" | "warning" | "danger";

const BADGE_TONES: Record<Tone, string> = {
  default: "bg-muted text-muted-foreground",
  accent: "bg-accent-muted text-accent",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
};

/** A lowercase word passed as the whole label ("live", "late") starts with a capital. */
const sentenceCase = (children: React.ReactNode) =>
  typeof children === "string" && children.length > 0 ? children.charAt(0).toUpperCase() + children.slice(1) : children;

/**
 * A short state or category beside the thing it describes: sentence case, in the text face.
 * `dot` adds a small mark in the tone's colour, so a status is never told by the tint alone.
 */
export function Badge({
  className,
  tone = "default",
  dot = false,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-xs font-medium",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" /> : null}
      {sentenceCase(children)}
    </span>
  );
}

/** One headline figure in its own card. For several figures side by side, use StatStrip. */
export function Metric({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "default" | "accent" | "warning";
}) {
  return (
    <Card className="flex flex-col gap-2">
      <span className="data-label">{label}</span>
      <span
        className={cn(
          "metric-value",
          tone === "accent" && "text-accent",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </Card>
  );
}

/**
 * A heading with an optional line of explanation and an action. At the top of a page it is
 * the page's title; inside a Card it is a section heading (globals.css sizes it by where it
 * sits). `level="section"` makes a section heading outside a card.
 */
export function SectionTitle({
  title,
  description,
  action,
  level,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  level?: "section";
  className?: string;
}) {
  return (
    <div className={cn("section-title flex flex-wrap items-end justify-between gap-x-4 gap-y-3", level === "section" && "section-title--section", className)}>
      {/* The text keeps a readable width: on a narrow screen the action drops under it instead of squeezing it. */}
      <div className="min-w-[min(100%,15rem)] flex-1">
        <h2 className="section-title-heading">{title}</h2>
        {description ? <p className="section-title-description mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-prose text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export interface Stat {
  label: string;
  value: React.ReactNode;
  /** The change against the comparison period (a DeltaChip). */
  delta?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "warning";
}

/**
 * Several figures in one card, divided by rules instead of a card each: the figures support
 * the page, they are not its structure.
 */
export function StatStrip({ stats, className, ...props }: { stats: Stat[] } & React.HTMLAttributes<HTMLDListElement>) {
  return (
    <dl
      className={cn(
        "bento grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:grid-cols-3",
        // Five or six sit on one line when there is room; any other number reads in rows of four.
        stats.length === 6 ? "xl:grid-cols-6" : stats.length === 5 ? "xl:grid-cols-5" : "lg:grid-cols-4",
        className,
      )}
      {...props}
    >
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <dt className="data-label truncate">{s.label}</dt>
          <dd className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("font-display text-2xl font-semibold tracking-[-0.02em] tabular-nums", s.tone === "warning" && "text-warning")}>{s.value}</span>
            {s.delta}
          </dd>
          {s.hint ? <dd className="mt-0.5 text-xs text-muted-foreground">{s.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
