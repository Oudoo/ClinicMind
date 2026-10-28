"use client";

import { TriangleAlert, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { highlightSegments } from "@/modules/consultations/summary";
import type { SummaryMention } from "@/modules/consultations/types";

/** Changes whenever the mentions change, so "the summary is correct" never carries over to a different mismatch. */
export function mentionSignature(mentions: readonly SummaryMention[]): string {
  return mentions.map((m) => `${m.kind}|${m.item}|${m.term}|${m.ranges.map((r) => r.join("-")).join(",")}`).join("\n");
}

/**
 * Under the visit summary: the removed draft items the summary still
 * mentions, highlighted in place, with a deterministic rewrite from the
 * signed items and a "The summary is correct" confirmation.
 */
export function SummaryCheck({
  summary,
  mentions,
  confirmed,
  onConfirmedChange,
  onRewrite,
  disabled = false,
}: {
  summary: string;
  mentions: readonly SummaryMention[];
  confirmed: boolean;
  onConfirmedChange: (value: boolean) => void;
  onRewrite: () => void;
  disabled?: boolean;
}) {
  if (!mentions.length) return null;
  const items = new Map<string, SummaryMention>();
  for (const m of mentions) if (!items.has(`${m.kind}|${m.item}`)) items.set(`${m.kind}|${m.item}`, m);
  const segments = highlightSegments(summary, mentions);

  return (
    <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/5 p-3" role="status" data-testid="summary-mismatch">
      <p className="flex gap-2 text-sm">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0">
          The summary still mentions {items.size === 1 ? "an item" : `${items.size} items`} you removed from the draft:{" "}
          {[...items.values()].map((m, i) => (
            <span key={`${m.kind}-${m.item}`}>
              {i ? ", " : ""}
              <span className="font-medium">{m.item}</span> <span className="text-muted-foreground">({m.kind})</span>
            </span>
          ))}
          . Signed summaries must match what is signed.
        </span>
      </p>
      <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-card px-3 py-2 text-sm leading-relaxed" aria-label="Summary with the removed items highlighted">
        {segments.map((s, i) =>
          s.mark ? (
            <mark key={i} className="rounded bg-warning/25 px-0.5 text-foreground">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRewrite}
          disabled={disabled}
          className="h-auto min-h-8 w-full whitespace-normal py-1.5 sm:w-auto"
        >
          <Wand2 />
          Rewrite summary from the signed items
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <Checkbox checked={confirmed} disabled={disabled} onChange={(e) => onConfirmedChange(e.target.checked)} data-testid="summary-confirm" />
          The summary is correct
        </label>
      </div>
    </div>
  );
}
