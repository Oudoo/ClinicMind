import Link from "next/link";
import type { Metadata } from "next";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { canApproveEvidence } from "@/lib/auth/rbac";
import { formatDateTimeInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { monthlyReview } from "@/modules/ai-log/review";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { DeltaChip } from "@/components/ui/kpi";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "AI monthly review" };

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/**
 * `/dashboard/evidence/review?month=YYYY-MM` — the owner's monthly review of
 * the clinic's AI: what was asked of the evidence panel and the assistant,
 * answered or not, how the doctors rated the answers and why the poor ones
 * were poor, what nothing answered, the sources cited most, the questions
 * taken to OpenEvidence and the prescribing-safety overrides.
 */
export default async function AiReviewPage({ searchParams }: { searchParams: Promise<{ month?: string | string[] }> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const header = (
    <SectionTitle
      title="AI monthly review"
      description="Every question asked of the clinic's AI is kept, with its answer, its sources and the doctor's rating. The month at a glance."
      action={
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard/evidence">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Evidence library
          </Link>
        </Button>
      }
    />
  );
  if (!canApproveEvidence(ctx)) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <EmptyState title="The monthly review is for the clinic owner" hint="The owner with the clinician mark reviews the questions, answers and ratings." />
        </Card>
      </div>
    );
  }

  const month = Array.isArray(sp.month) ? sp.month[0] : sp.month;
  const [r, timezone] = await Promise.all([monthlyReview(ctx.tenantId, month), getTenantTimezone(ctx.tenantId)]);
  const when = (iso: string) => formatDateTimeInTz(new Date(iso), timezone);

  return (
    <div className="space-y-6">
      {header}
      <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Month">
        <label className="space-y-1.5">
          <span className="data-label block">Month</span>
          <Select name="month" defaultValue={r.month} className="w-48">
            {r.months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="outline" size="sm" className="h-10">
          Show
        </Button>
      </form>

      <Bento>
        <Metric label="Questions" value={r.questions.total} hint={`${r.questions.evidence} evidence panel · ${r.questions.assistant} assistant`} />
        <Metric label="Answered from sources or records" value={pct(r.questions.answered, r.questions.total)} hint={`${r.questions.answered} answered · ${r.questions.unanswered} not${r.questions.failed ? ` · ${r.questions.failed} failed` : ""}`} tone="accent" />
        <Metric label="Rated useful" value={pct(r.ratings.helpful, r.ratings.rated)} hint={`${r.ratings.rated} rated · ${r.ratings.notHelpful} not useful`} />
        <Metric label="Safety overrides" value={r.overrides.total} hint={`${r.overrides.stops} stops · ${r.overrides.warnings} warnings`} tone={r.overrides.stops ? "warning" : "default"} />
      </Bento>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        Questions against the month before: <DeltaChip current={r.questions.total} previous={r.questions.previousTotal} goodWhen="up" /> ({r.questions.previousTotal} then).
        {r.questions.external ? ` ${r.questions.external} question${r.questions.external === 1 ? "" : "s"} taken to OpenEvidence, without the patient's name.` : ""}
      </p>

      <Card className="space-y-3">
        <SectionTitle title="Answers rated not useful" description="What the doctors said was wrong, with the question and the sources the answer cited." />
        {r.notHelpful.length ? (
          <ul className="space-y-3" data-testid="review-not-helpful">
            {r.notHelpful.map((q) => (
              <li key={q.runId} className="space-y-1 rounded-lg border border-border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge>{q.kindLabel}</Badge>
                  {q.by} · {when(q.at)}
                </p>
                <p className="font-medium" dir="auto">
                  {q.question}
                </p>
                {q.comment ? (
                  <p className="text-sm" dir="auto">
                    <span className="text-muted-foreground">Doctor: </span>“{q.comment}”
                  </p>
                ) : null}
                <p className="line-clamp-3 text-xs text-muted-foreground" dir="auto">
                  {q.answer}
                </p>
                {q.sources.length ? <p className="text-xs text-muted-foreground">Sources: {q.sources.join("; ")}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No answer was rated not useful this month" />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="space-y-3">
          <SectionTitle title="By doctor" />
          {r.byDoctor.length ? (
            <div className="overflow-x-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>Who</TH>
                    <TH className="text-right">Questions</TH>
                    <TH className="text-right">Answered</TH>
                    <TH className="text-right">Useful</TH>
                    <TH className="text-right">Not useful</TH>
                  </TR>
                </THead>
                <TBody>
                  {r.byDoctor.map((d) => (
                    <TR key={d.name}>
                      <TD>{d.name}</TD>
                      <TD className="text-right tabular-nums">{d.questions}</TD>
                      <TD className="text-right tabular-nums">{d.answered}</TD>
                      <TD className="text-right tabular-nums">{d.helpful}</TD>
                      <TD className="text-right tabular-nums">{d.notHelpful}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : (
            <EmptyState title="No questions this month" />
          )}
        </Card>

        <Card className="space-y-3">
          <SectionTitle title="Sources cited most" description="From the evidence panel's answers." />
          {r.sources.length ? (
            <ul className="space-y-1 text-sm">
              {r.sources.map((s) => (
                <li key={s.title} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0" dir="auto">
                    {s.title}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{s.cited}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No source was cited this month" />
          )}
        </Card>
      </div>

      <Card className="space-y-3">
        <SectionTitle title="Not answered" description="Questions no approved source or record answered: a source the library may need." />
        {r.unanswered.length ? (
          <ul className="divide-y divide-border text-sm" data-testid="review-unanswered">
            {r.unanswered.map((q) => (
              <li key={q.runId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="min-w-0" dir="auto">
                  {q.question}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {q.kindLabel} · {q.by} · {when(q.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Every question was answered from sources or records" />
        )}
      </Card>

      <Card className="space-y-3">
        <SectionTitle
          title="Prescribing-safety overrides"
          description="Stops signed through with a reason and warnings acknowledged, by rule."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/safety">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                All overrides
              </Link>
            </Button>
          }
        />
        {r.overrides.byRule.length ? (
          <ul className="space-y-1 text-sm">
            {r.overrides.byRule.map((o) => (
              <li key={o.label} className="flex items-baseline justify-between gap-3">
                <span>{o.label}</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{o.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No override this month" />
        )}
      </Card>
    </div>
  );
}
