import { CheckCircle2, CircleSlash } from "lucide-react";
import { formatNumber } from "@/lib/utils";
import { formatDateInTz } from "@/lib/time";
import { countedUnit, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from "@/modules/quotes/constants";
import { QUOTE_COPY, unitWord } from "@/modules/quotes/copy";
import type { PublicQuoteDTO, PublicQuoteItemDTO } from "@/modules/quotes/dto";

/**
 * A treatment plan and quote as the patient sees it, printed or on screen, in
 * Arabic or English: the clinic and branch, the number (or "draft"), the day
 * it was given and the last day it holds, the patient and doctor, each phase
 * with its treatments (where, how many, in how many sessions, the price and
 * any discount), the totals, the terms and, once answered, the signature.
 * Server-rendered; `print-area` keeps only the document on paper, with a
 * line to sign by hand while it is open.
 */
export function QuoteDocument({ quote }: { quote: PublicQuoteDTO }) {
  const t = QUOTE_COPY[quote.language];
  const date = (iso: string) => formatDateInTz(new Date(iso), quote.timezone, { day: "numeric", month: "long", year: "numeric" }, t.locale);
  const money = (n: number) => formatNumber(n);
  const answered = quote.status === "ACCEPTED";
  const validUntil = date(quote.validUntil);

  return (
    <article dir={t.dir} lang={quote.language} className="print-area space-y-6 rounded-lg border border-border bg-card p-5 text-sm sm:p-8" aria-label={quote.number ? `${t.number} ${quote.number}` : t.draft} data-testid="quote-document">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* <bdi>: English names keep their own order inside an Arabic quote. */}
          <p className="font-display text-lg font-semibold">
            <bdi>{quote.tenantName}</bdi>
          </p>
          <p className="text-muted-foreground">
            <bdi>{quote.clinic.name}</bdi>
          </p>
          {quote.clinic.address ? (
            <p className="text-xs text-muted-foreground">
              <bdi>{quote.clinic.address}</bdi>
            </p>
          ) : null}
          {quote.clinic.phone ? (
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{quote.clinic.phone}</bdi>
            </p>
          ) : null}
        </div>
        <div className="sm:text-end">
          <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">
            <bdi>{quote.title ?? t.title}</bdi>
          </h1>
          {quote.number ? (
            <p>
              <span className="text-muted-foreground">{t.number}: </span>
              <span className="font-mono" dir="ltr">
                {quote.number}
              </span>
            </p>
          ) : (
            <p className="font-medium text-warning">{t.draft}</p>
          )}
          <p>
            <span className="text-muted-foreground">{t.date}: </span>
            {date(quote.sentAt ?? quote.createdAt)}
          </p>
          <p>
            <span className="text-muted-foreground">{t.validUntil}: </span>
            <span className={quote.state === "EXPIRED" ? "text-danger" : undefined}>{validUntil}</span>
          </p>
          <p className="mt-1 inline-block rounded border border-border px-2 py-0.5 text-xs uppercase tracking-wide" data-testid="quote-state">
            {t.state[quote.state]}
          </p>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <p className="data-label">{t.preparedFor}</p>
          <p className="font-medium">
            <bdi>{quote.patient.fullName}</bdi>
          </p>
          {quote.patient.phone ? (
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{quote.patient.phone}</bdi>
            </p>
          ) : null}
        </div>
        {quote.doctor ? (
          <div>
            <p className="data-label">{t.doctor}</p>
            <p>
              <bdi>{quote.doctor.fullName}</bdi>
            </p>
          </div>
        ) : null}
        <div>
          <p className="data-label">{t.branch}</p>
          <p>
            <bdi>{quote.clinic.name}</bdi>
          </p>
        </div>
      </section>

      {quote.phases.map((title, p) => {
        const items = quote.items.filter((i) => i.phase === p);
        if (!items.length) return null;
        const phaseTotal = items.reduce((s, i) => s + i.net, 0);
        return (
          <section key={p} className="space-y-2" aria-label={`${t.phase(p + 1)}: ${title}`}>
            <h2 className="font-display text-base font-semibold">
              {t.phase(p + 1)} · <bdi>{title}</bdi>
            </h2>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 text-start font-normal">{t.treatment}</th>
                  <th className="py-2 text-end font-normal">{t.amount}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <ItemRow key={i.id} item={i} quote={quote} money={money} />
                ))}
              </tbody>
            </table>
            {quote.phases.length > 1 ? (
              <p className="flex justify-between gap-4 text-xs text-muted-foreground">
                <span>{t.phaseTotal}</span>
                <span className="font-mono tabular-nums" dir="ltr">
                  {money(phaseTotal)}
                </span>
              </p>
            ) : null}
          </section>
        );
      })}

      <dl className="ms-auto w-full max-w-xs space-y-1">
        {quote.discountTotal > 0 ? (
          <>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <dt>{t.beforeDiscounts}</dt>
              <dd className="font-mono tabular-nums" dir="ltr">
                {money(quote.listTotal)}
              </dd>
            </div>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <dt>{t.discounts}</dt>
              <dd className="font-mono tabular-nums" dir="ltr">
                −{money(quote.discountTotal)}
              </dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
          <dt>{t.total}</dt>
          <dd className="font-mono tabular-nums" dir="ltr" data-testid="quote-total">
            {money(quote.total)}
          </dd>
        </div>
        {answered && quote.acceptedTotal !== null && quote.acceptedTotal !== quote.total ? (
          <div className="flex justify-between gap-4 font-semibold text-success">
            <dt>{t.acceptedTotal}</dt>
            <dd className="font-mono tabular-nums" dir="ltr">
              {money(quote.acceptedTotal)}
            </dd>
          </div>
        ) : null}
      </dl>

      {quote.note ? (
        <p className="whitespace-pre-wrap text-sm" dir="auto">
          {quote.note}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t.terms(validUntil)}</p>

      {answered && quote.acceptedAt && quote.acceptedName && quote.acceptedVia ? (
        <section className="space-y-2 rounded-md border border-success/40 bg-success/5 p-3" data-testid="quote-accepted">
          <p className="font-medium">{t.accepted(quote.acceptedName, date(quote.acceptedAt), quote.acceptedVia)}</p>
          {quote.signature ? <Signature path={quote.signature} label={t.signature} /> : null}
        </section>
      ) : quote.status === "DECLINED" && quote.declinedAt ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 font-medium">{t.declined(date(quote.declinedAt))}</p>
      ) : quote.status === "WITHDRAWN" && quote.withdrawnAt ? (
        <p className="rounded-md border border-border bg-muted/40 p-3 font-medium">{t.withdrawn(date(quote.withdrawnAt))}</p>
      ) : quote.state === "EXPIRED" ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-3 font-medium">{t.expired(validUntil)}</p>
      ) : (
        // On paper, a line to sign by hand.
        <div className="hidden grid-cols-2 gap-8 pt-8 print:grid">
          <p className="border-t border-foreground pt-1 text-xs">{t.signature}</p>
          <p className="border-t border-foreground pt-1 text-xs">{t.signatureDate}</p>
        </div>
      )}

      <footer className="border-t border-border pt-3 text-center text-xs text-muted-foreground">
        {t.thanks} <bdi>{quote.tenantName}</bdi>
      </footer>
    </article>
  );
}

function ItemRow({ item, quote, money }: { item: PublicQuoteItemDTO; quote: PublicQuoteDTO; money: (n: number) => string }) {
  const t = QUOTE_COPY[quote.language];
  const details = [
    item.site,
    item.unit === "SESSION" ? t.sessions(item.stages) : countedUnit(item.unit) ? t.quantity(money(item.quantity), unitWord(item.unit, item.unitLabel, item.quantity, quote.language)) : null,
    item.unit !== "SESSION" && item.stages > 1 ? t.sessions(item.stages) : null,
  ].filter(Boolean);
  const declined = item.accepted === false;
  return (
    <tr className="border-b border-border/60 align-top">
      <td className="py-2 pe-3">
        <span className={declined ? "text-muted-foreground line-through" : undefined} dir="auto">
          {item.description}
        </span>
        {details.length ? <span className="block text-xs text-muted-foreground">{details.join(" · ")}</span> : null}
        {item.accepted === true ? (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t.itemAccepted}
          </span>
        ) : declined ? (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
            <CircleSlash className="h-3.5 w-3.5" aria-hidden="true" />
            {t.notAccepted}
          </span>
        ) : null}
      </td>
      <td className="whitespace-nowrap py-2 text-end font-mono tabular-nums" dir="ltr">
        <span className={declined ? "text-muted-foreground line-through" : undefined}>{money(item.net)}</span>
        {item.discount > 0 ? (
          <span className="block text-[11px] text-muted-foreground">
            {money(item.price)} · {t.discount(money(item.discount))}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

/** The signature as it was drawn, on the pad's own proportions. */
export function Signature({ path, label }: { path: string; label: string }) {
  return (
    <figure className="max-w-xs">
      <svg viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`} className="h-auto w-full rounded border border-border bg-background text-foreground" role="img" aria-label={label}>
        <path d={path} fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <figcaption className="mt-0.5 text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
