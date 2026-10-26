"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Columns, Spark } from "@/components/ui/kpi";
import { EmptyState } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { MetricBadge } from "./report-shared";

export interface ReviewPointDTO {
  /** YYYY-MM-DD, the first day (Saturday) of the clinic week. */
  weekStart: string;
  count: number;
  rating: number;
  source: string;
}

const dm = (key: string) => `${Number(key.slice(8, 10))}/${Number(key.slice(5, 7))}`;

/**
 * Public reviews (M11): the latest count and rating, new reviews per week
 * over the last twelve weeks, and the owner's weekly manual entry (used until
 * the Google Business Profile pull is configured).
 */
export function ReportReviewsCard({ trend, canEnter, thisWeek }: { trend: ReviewPointDTO[]; canEnter: boolean; thisWeek: string }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const latest = trend[trend.length - 1] ?? null;
  const [week, setWeek] = useState(thisWeek);
  const [count, setCount] = useState(latest ? String(latest.count) : "");
  const [rating, setRating] = useState(latest ? String(latest.rating) : "");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const perWeek = trend.slice(1).map((p, i) => ({ label: dm(p.weekStart), value: Math.max(0, p.count - (trend[i]?.count ?? p.count)) }));
  const added = trend.length > 1 ? latest!.count - trend[0]!.count : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = Number(count);
    const r = Number(rating);
    const next: Record<string, string> = {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) next.weekStart = "Choose the week.";
    if (!Number.isInteger(c) || c < 0) next.count = "A whole number.";
    if (!Number.isFinite(r) || r < 0 || r > 5) next.rating = "0 to 5.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/reviews/snapshots", { method: "POST", body: { weekStart: week, count: c, rating: r } });
      toast({ tone: "success", title: "Reviews saved for the week", description: `${c} reviews at ${r.toFixed(1)}` });
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const issue = (k: string) => (issues[k] ? <span className="text-danger">{issues[k]}</span> : undefined);
  return (
    <section aria-label="Public reviews" className="min-w-0 space-y-3 rounded-lg border border-border p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <MetricBadge id="M11" />
        <h4 className="text-sm font-semibold">Public reviews, weekly</h4>
      </div>
      {latest ? (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <div className="data-label">Reviews</div>
              <div className="font-display text-2xl font-semibold tabular-nums">{latest.count.toLocaleString("en-US")}</div>
              {added !== null ? <div className="text-xs text-muted-foreground">+{added} over {trend.length} weeks</div> : null}
            </div>
            <div>
              <div className="data-label">Rating</div>
              <div className="flex items-center gap-1 font-display text-2xl font-semibold tabular-nums">
                {latest.rating.toFixed(2)}
                <Star className="h-4 w-4 fill-current text-warning" aria-hidden="true" />
              </div>
              <div className="text-xs text-muted-foreground">week of {latest.weekStart}</div>
            </div>
            <div className="min-w-[8rem] flex-1">
              <div className="data-label">Rating trend</div>
              <Spark values={trend.map((p) => p.rating)} />
            </div>
          </div>
          {perWeek.length ? (
            <div>
              <div className="data-label mb-1">New reviews per week</div>
              <Columns items={perWeek} height="h-24" />
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState title="No review counts yet" hint={canEnter ? "Enter this week's count and rating below." : "The owner enters them weekly."} />
      )}
      {canEnter ? (
        <form onSubmit={submit} className="space-y-2 border-t border-border pt-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <p className="text-xs text-muted-foreground">Enter the week&apos;s total from Google; entering a week again replaces it.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="Week of" htmlFor={`${id}-week`} hint={issue("weekStart")}>
              <Input id={`${id}-week`} type="date" value={week} onChange={(e) => setWeek(e.target.value)} className="h-9" />
            </Field>
            <Field label="Reviews" htmlFor={`${id}-count`} hint={issue("count")}>
              <Input id={`${id}-count`} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} className="h-9" />
            </Field>
            <Field label="Rating" htmlFor={`${id}-rating`} hint={issue("rating")}>
              <Input id={`${id}-rating`} inputMode="decimal" value={rating} onChange={(e) => setRating(e.target.value)} className="h-9" />
            </Field>
            <div className="flex items-end">
              <Button type="submit" size="sm" className="h-9 w-full" disabled={busy}>
                {busy ? "Saving…" : "Save week"}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </section>
  );
}
