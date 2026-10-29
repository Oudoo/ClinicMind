import type { Metadata } from "next";
import { FileX2 } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { quoteByToken, quoteDate } from "@/modules/quotes/service";
import { QUOTE_COPY } from "@/modules/quotes/copy";
import { QuoteDocument } from "@/components/clinicmind/quote-document";
import { QuoteAnswerForm } from "@/components/clinicmind/quote-answer-form";
import { PrintButton } from "@/components/clinicmind/invoice-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Treatment plan",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on in a Referer header.
  referrer: "no-referrer",
};

/**
 * `/q/[token]` — the patient's treatment plan and quote, behind the link in
 * the WhatsApp message: read it, print it, and accept it (all of it or some
 * treatments) with a signature, or decline it. No dashboard and no session:
 * the token is the only key, looked up by its hash; the latest link sent is
 * the one that works.
 */
export default async function PatientQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const quote = await quoteByToken(token);
  if (!quote) return <ExpiredLink />;
  const t = QUOTE_COPY[quote.language];
  const banner =
    quote.status === "ACCEPTED"
      ? { tone: "success", title: t.done.accepted.title, body: t.done.accepted.body }
      : quote.status === "DECLINED"
        ? { tone: "muted", title: null, body: t.closed.declined }
        : quote.status === "WITHDRAWN"
          ? { tone: "muted", title: null, body: t.closed.withdrawn }
          : quote.state === "EXPIRED"
            ? { tone: "warning", title: null, body: t.closed.expired(quoteDate(quote.validUntil, quote.timezone, quote.language)) }
            : null;
  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="no-print flex justify-end">
          <PrintButton label={t.print} />
        </div>
        {banner ? (
          <section
            dir={t.dir}
            lang={quote.language}
            role="status"
            data-testid="quote-banner"
            className={
              banner.tone === "success"
                ? "no-print rounded-lg border border-success/40 bg-success/5 p-4"
                : banner.tone === "warning"
                  ? "no-print rounded-lg border border-warning/40 bg-warning/5 p-4"
                  : "no-print rounded-lg border border-border bg-muted/40 p-4"
            }
          >
            {banner.title ? <h2 className="font-display text-lg font-semibold">{banner.title}</h2> : null}
            <p className="text-sm">{banner.body}</p>
          </section>
        ) : null}
        <QuoteDocument quote={quote} />
        {quote.state === "SENT" ? (
          <div className="no-print bento">
            <QuoteAnswerForm quote={quote} mode={{ kind: "link", token }} />
          </div>
        ) : null}
        <p className="no-print text-center text-xs text-muted-foreground">{BRAND.productName}</p>
      </div>
    </main>
  );
}

function ExpiredLink() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="bento w-full max-w-md space-y-4 text-center">
        <FileX2 className="mx-auto h-10 w-10 text-warning" aria-hidden="true" />
        <section dir="rtl" lang="ar" className="space-y-1">
          <h1 className="font-display text-xl font-semibold tracking-tight">{QUOTE_COPY.ar.gone.title}</h1>
          <p className="text-sm text-muted-foreground">{QUOTE_COPY.ar.gone.body}</p>
        </section>
        <hr className="border-border" />
        <section dir="ltr" lang="en" className="space-y-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">{QUOTE_COPY.en.gone.title}</h2>
          <p className="text-sm text-muted-foreground">{QUOTE_COPY.en.gone.body}</p>
        </section>
      </div>
    </main>
  );
}
