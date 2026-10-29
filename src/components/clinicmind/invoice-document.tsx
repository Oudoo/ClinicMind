import { formatNumber } from "@/lib/utils";
import { formatDateInTz } from "@/lib/time";
import type { InvoiceDTO } from "@/modules/finance/invoices";

/**
 * An invoice as the patient sees it, printed or on screen, in Arabic or
 * English: the clinic and branch, the number (or "draft"), the patient, the
 * lines, the totals, the payments put towards it with their receipt numbers
 * and, once cancelled, the credit note. Server-rendered; `print-area` keeps
 * only the document on paper.
 */

const COPY = {
  en: {
    invoice: "Invoice",
    draft: "Draft — not issued",
    number: "Invoice no.",
    issued: "Date",
    billedTo: "Billed to",
    branch: "Branch",
    item: "Item",
    when: "Done on",
    amount: "Amount (EGP)",
    total: "Total",
    paid: "Paid",
    writtenOff: "Written off",
    claimed: "Claimed from the insurer",
    claims: "Insurance claims",
    claim: "Claim",
    card: "card",
    claimCancelled: "cancelled",
    closedWrittenOff: "Closed: written off",
    due: "To pay",
    payments: "Payments",
    receipt: "Receipt",
    cancelled: "Cancelled by credit note",
    reason: "Reason",
    thanks: "Thank you for choosing",
    status: { DRAFT: "Draft", ISSUED: "Issued", PART_PAID: "Part-paid", PAID: "Paid", CANCELLED: "Cancelled" } as Record<string, string>,
    method: { CASH: "Cash", CARD: "Card", BANK_TRANSFER: "Bank transfer", WALLET: "Wallet", POS: "Card machine", INSTAPAY: "InstaPay", CHEQUE: "Cheque", OTHER: "Other" } as Record<string, string>,
  },
  ar: {
    invoice: "فاتورة",
    draft: "مسودة — لم تصدر بعد",
    number: "رقم الفاتورة",
    issued: "التاريخ",
    billedTo: "إلى",
    branch: "الفرع",
    item: "البند",
    when: "التاريخ",
    amount: "المبلغ (جنيه)",
    total: "الإجمالي",
    paid: "المدفوع",
    writtenOff: "مشطوب",
    claimed: "تتحمله جهة التأمين",
    claims: "مطالبات التأمين",
    claim: "مطالبة",
    card: "بطاقة",
    claimCancelled: "ملغاة",
    closedWrittenOff: "مغلقة: مشطوبة",
    due: "المتبقي",
    payments: "المدفوعات",
    receipt: "إيصال",
    cancelled: "ألغيت بإشعار دائن",
    reason: "السبب",
    thanks: "شكرًا لاختياركم",
    status: { DRAFT: "مسودة", ISSUED: "صادرة", PART_PAID: "مدفوعة جزئيًا", PAID: "مدفوعة", CANCELLED: "ملغاة" } as Record<string, string>,
    method: { CASH: "نقدًا", CARD: "بطاقة", BANK_TRANSFER: "تحويل بنكي", WALLET: "محفظة إلكترونية", POS: "ماكينة دفع", INSTAPAY: "إنستاباي", CHEQUE: "شيك", OTHER: "أخرى" } as Record<string, string>,
  },
} as const;

export function InvoiceDocument({ invoice }: { invoice: InvoiceDTO }) {
  const ar = invoice.language === "ar";
  const t = COPY[invoice.language];
  const date = (iso: string) => formatDateInTz(new Date(iso), invoice.timezone, { day: "numeric", month: "long", year: "numeric" }, ar ? "ar-EG-u-nu-latn" : "en-GB");
  const money = (n: number) => formatNumber(n);
  const cancelled = invoice.status === "CANCELLED";

  return (
    <article dir={ar ? "rtl" : "ltr"} lang={invoice.language} className="print-area space-y-6 rounded-lg border border-border bg-card p-5 text-sm sm:p-8" aria-label={invoice.number ? `${t.invoice} ${invoice.number}` : t.draft}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {/* <bdi>: English names keep their own order inside an Arabic invoice, and its alignment. */}
          <p className="font-display text-lg font-semibold">
            <bdi>{invoice.tenantName}</bdi>
          </p>
          <p className="text-muted-foreground">
            <bdi>{invoice.clinic.name}</bdi>
          </p>
          {invoice.clinic.address ? (
            <p className="text-xs text-muted-foreground">
              <bdi>{invoice.clinic.address}</bdi>
            </p>
          ) : null}
          {invoice.clinic.phone ? (
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{invoice.clinic.phone}</bdi>
            </p>
          ) : null}
        </div>
        <div className="sm:text-end">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{t.invoice}</h1>
          {invoice.number ? (
            <p>
              <span className="text-muted-foreground">{t.number}: </span>
              <span className="font-mono" dir="ltr">
                {invoice.number}
              </span>
            </p>
          ) : (
            <p className="font-medium text-warning">{t.draft}</p>
          )}
          {invoice.issuedAt ? (
            <p>
              <span className="text-muted-foreground">{t.issued}: </span>
              {date(invoice.issuedAt)}
            </p>
          ) : null}
          <p className="mt-1 inline-block rounded border border-border px-2 py-0.5 text-xs uppercase tracking-wide">
            {invoice.status === "PAID" && invoice.writtenOff > 0 ? t.closedWrittenOff : (t.status[invoice.status] ?? invoice.status)}
          </p>
        </div>
      </header>

      <section>
        <p className="data-label">{t.billedTo}</p>
        <p className="font-medium">
          <bdi>{invoice.patient.fullName}</bdi>
        </p>
        {invoice.patient.phone ? (
          <p className="text-xs text-muted-foreground">
            <bdi dir="ltr">{invoice.patient.phone}</bdi>
          </p>
        ) : null}
      </section>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 text-start font-normal">{t.item}</th>
              <th className="hidden py-2 text-start font-normal sm:table-cell">{t.when}</th>
              <th className="py-2 text-end font-normal">{t.amount}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.id} className="border-b border-border/60 align-top">
                <td className="py-2 pe-3">
                  <span dir="auto">{l.description}</span>
                  <span className="block text-xs text-muted-foreground sm:hidden">{date(l.chargedAt)}</span>
                </td>
                <td className="hidden whitespace-nowrap py-2 pe-3 text-muted-foreground sm:table-cell">{date(l.chargedAt)}</td>
                <td className="whitespace-nowrap py-2 text-end font-mono tabular-nums" dir="ltr">
                  {money(l.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="ms-auto w-full max-w-xs space-y-1">
        <div className="flex justify-between gap-4 font-medium">
          <dt>{t.total}</dt>
          <dd className="font-mono tabular-nums" dir="ltr">
            {money(invoice.total)}
          </dd>
        </div>
        {invoice.status !== "DRAFT" && !cancelled ? (
          <>
            <div className="flex justify-between gap-4 text-muted-foreground">
              <dt>{t.paid}</dt>
              <dd className="font-mono tabular-nums" dir="ltr">
                {money(invoice.paid)}
              </dd>
            </div>
            {invoice.claimed > 0 ? (
              <div className="flex justify-between gap-4 text-muted-foreground">
                <dt>{t.claimed}</dt>
                <dd className="font-mono tabular-nums" dir="ltr">
                  {money(invoice.claimed)}
                </dd>
              </div>
            ) : null}
            {invoice.writtenOff > 0 ? (
              <div className="flex justify-between gap-4 text-muted-foreground">
                <dt>{t.writtenOff}</dt>
                <dd className="font-mono tabular-nums" dir="ltr">
                  {money(invoice.writtenOff)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold">
              <dt>{t.due}</dt>
              <dd className="font-mono tabular-nums" dir="ltr">
                {money(invoice.due)}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      {invoice.payments.length && !cancelled ? (
        <section className="space-y-1">
          <p className="data-label">{t.payments}</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {invoice.payments.map((p, i) => (
              <li key={`${p.receiptNumber}-${i}`} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  {t.receipt}{" "}
                  <span className="font-mono" dir="ltr">
                    {p.receiptNumber ?? "—"}
                  </span>{" "}
                  · {date(p.paidAt)} · {t.method[p.method] ?? p.method}
                </span>
                <span className="shrink-0 font-mono tabular-nums" dir="ltr">
                  {money(p.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {invoice.claims.length ? (
        <section className="space-y-1" data-testid="invoice-claims">
          <p className="data-label">{t.claims}</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {invoice.claims.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  {t.claim}{" "}
                  <span className="font-mono" dir="ltr">
                    {c.number}
                  </span>{" "}
                  · <bdi>{c.payerName}</bdi> · {t.card}{" "}
                  <span className="font-mono" dir="ltr">
                    {c.memberNumber}
                  </span>
                  {c.status === "CANCELLED" ? ` · ${t.claimCancelled}` : ""}
                </span>
                <span className="shrink-0 font-mono tabular-nums" dir="ltr">
                  {money(c.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {cancelled && invoice.creditNote ? (
        <section className="rounded-md border border-danger/40 bg-danger/5 p-3">
          <p className="font-medium">
            {t.cancelled}{" "}
            <span className="font-mono" dir="ltr">
              {invoice.creditNote.number}
            </span>{" "}
            · {date(invoice.creditNote.issuedAt)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t.reason}: {invoice.creditNote.reason}
          </p>
        </section>
      ) : null}

      {invoice.note ? <p className="text-xs text-muted-foreground">{invoice.note}</p> : null}
      <footer className="border-t border-border pt-3 text-center text-xs text-muted-foreground">
        {t.thanks} {invoice.tenantName}
      </footer>
    </article>
  );
}
