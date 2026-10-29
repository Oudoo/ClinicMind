import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz, formatDateTimeInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { getQuote, QuoteNotFoundError, discountReasonLabel } from "@/modules/quotes/service";
import { PROCEDURE_STATUS_LABELS, type ProcedureStatusValue } from "@/modules/finance/constants";
import { Badge, Card, SectionTitle } from "@/components/ui/primitives";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { QuoteDocument } from "@/components/clinicmind/quote-document";
import { QuoteActions } from "@/components/clinicmind/quote-actions";
import { QuoteStateBadge } from "@/components/clinicmind/quote-shared";
import { PrintButton } from "@/components/clinicmind/invoice-actions";
import { STATUS_TONE } from "@/components/clinicmind/finance-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Treatment plan" };

/**
 * `/dashboard/quotes/[id]` — one treatment plan as the patient sees it, with
 * what can be done with it and, for the clinic only, its history: when it
 * was given and sent, the discounts' reasons, the quote it revises or that
 * replaced it, and the planned procedures its accepted treatments became.
 */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "quotes:read")) {
    return <NotForRole title="Not available for your role" hint="Treatment plans are for the doctors, the front desk and the clinic owner." />;
  }
  const quote = await getQuote(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof QuoteNotFoundError) return null;
    throw err;
  });
  if (!quote) notFound();
  const when = (iso: string) => formatDateTimeInTz(new Date(iso), quote.timezone);
  const discounts = quote.items.filter((i) => i.discount > 0);
  const accepted = quote.items.filter((i) => i.procedure);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="no-print flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1 text-sm">
          <Link href={`/dashboard/patients/${quote.patient.id}`} className="text-accent underline-offset-2 hover:underline">
            ← {quote.patient.fullName}
          </Link>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <QuoteStateBadge state={quote.state} />
            {quote.sentAt ? <span>Given {when(quote.sentAt)}</span> : <span>Draft from {when(quote.createdAt)}</span>}
            {quote.linkSentAt ? <span>· link sent {when(quote.linkSentAt)}</span> : null}
          </p>
        </div>
        {can(ctx.role, "quotes:write") ? <QuoteActions quote={quote} todayKey={dateKeyInTz(new Date(), quote.timezone)} /> : quote.status !== "DRAFT" ? <PrintButton /> : null}
      </div>

      {quote.revisionOf || quote.revisions.length || quote.declineReason || quote.withdrawnReason || discounts.length || accepted.length ? (
        <Card className="no-print space-y-3 text-sm">
          <SectionTitle title="For the clinic" description="Not on the patient's copy." />
          {quote.revisionOf ? (
            <p>
              Revises{" "}
              <Link href={`/dashboard/quotes/${quote.revisionOf.id}`} className="font-mono text-accent underline-offset-2 hover:underline">
                {quote.revisionOf.number ?? "a draft"}
              </Link>
              {quote.status === "DRAFT" ? ", which it replaces once given." : "."}
            </p>
          ) : null}
          {quote.revisions.length ? (
            <p>
              Revised as{" "}
              {quote.revisions.map((r, i) => (
                <span key={r.id}>
                  {i ? ", " : ""}
                  <Link href={`/dashboard/quotes/${r.id}`} className="font-mono text-accent underline-offset-2 hover:underline">
                    {r.number ?? "a draft"}
                  </Link>
                </span>
              ))}
              .
            </p>
          ) : null}
          {quote.declineReason ? <p>The patient said: “{quote.declineReason}”</p> : null}
          {quote.withdrawnReason ? <p>Withdrawn: {quote.withdrawnReason}</p> : null}
          {discounts.length ? (
            <ul className="space-y-0.5 text-xs text-muted-foreground" aria-label="Discounts">
              {discounts.map((i) => (
                <li key={i.id}>
                  {i.description}: {formatNumber(i.discount)} EGP off — {discountReasonLabel(i.discountReason, i.discountNote)}
                </li>
              ))}
            </ul>
          ) : null}
          {accepted.length ? (
            <div className="space-y-1">
              <p className="data-label">Planned procedures</p>
              <ul className="space-y-1" data-testid="quote-procedures">
                {accepted.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {i.description}
                      {i.site ? <span className="text-muted-foreground"> · {i.site}</span> : null}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs tabular-nums">{formatNumber(i.net)} EGP</span>
                      <Badge tone={STATUS_TONE[i.procedure!.status as ProcedureStatusValue] ?? "default"}>{PROCEDURE_STATUS_LABELS[i.procedure!.status as ProcedureStatusValue] ?? i.procedure!.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                On the patient&apos;s page under Procedures &amp; payments; book them from there or from the recall list.
              </p>
            </div>
          ) : null}
        </Card>
      ) : null}

      <QuoteDocument quote={quote} />
    </div>
  );
}
