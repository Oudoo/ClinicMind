import { formatNumber } from "@/lib/utils";
import { formatDateInTz, fromDateKey } from "@/lib/time";
import type { LedgerView } from "@/modules/finance/ledger";
import { balanceWords, relationLabel, type LedgerLanguage } from "@/modules/finance/ledger-copy";
import { LedgerText } from "./ledger-text";

/**
 * A statement of account as the patient (or the head of their family) gets
 * it, printed or on screen, in Arabic or English: the clinic, who it is for,
 * the period, the balance brought forward, every line with the running
 * balance, the balance at the end, and the invoices still to pay.
 * Server-rendered; `print-area` keeps only the document on paper.
 */

const COPY = {
  en: {
    title: "Statement of account",
    familyTitle: "Family statement of account",
    period: "Period",
    upTo: "Up to",
    everything: "Every date",
    printed: "Printed on",
    for: "For",
    family: "Family",
    paysFor: "pays for the family",
    date: "Date",
    patient: "Patient",
    reference: "Reference",
    details: "Details",
    charges: "Charges",
    payments: "Payments",
    amount: "Amount",
    balance: "Balance",
    broughtForward: "Balance brought forward",
    atEnd: "Balance at the end of the period",
    nothing: "Nothing on the account in this period.",
    totals: "Totals for the period",
    openInvoices: "Invoices still to pay (today)",
    invoice: "Invoice",
    total: "Total",
    paid: "Paid",
    due: "To pay",
    note: "Amounts in EGP. A positive balance is owed to the clinic; a negative balance is credit.",
    thanks: "Thank you for choosing",
  },
  ar: {
    title: "كشف حساب",
    familyTitle: "كشف حساب العائلة",
    period: "الفترة",
    upTo: "حتى",
    everything: "كل التواريخ",
    printed: "تاريخ الطباعة",
    for: "إلى",
    family: "العائلة",
    paysFor: "يدفع عن العائلة",
    date: "التاريخ",
    patient: "المريض",
    reference: "المرجع",
    details: "البيان",
    charges: "مدين",
    payments: "دائن",
    amount: "المبلغ",
    balance: "الرصيد",
    broughtForward: "رصيد سابق",
    atEnd: "الرصيد في نهاية الفترة",
    nothing: "لا توجد حركات على الحساب في هذه الفترة.",
    totals: "إجمالي الفترة",
    openInvoices: "فواتير لم تسدد بعد (اليوم)",
    invoice: "الفاتورة",
    total: "الإجمالي",
    paid: "المدفوع",
    due: "المتبقي",
    note: "المبالغ بالجنيه المصري. الرصيد الموجب مستحق للعيادة، والسالب رصيد دائن للمريض.",
    thanks: "شكرًا لاختياركم",
  },
} as const;

/** Columns shown from a tablet up and on paper; on a phone, one Amount column and the date under the details. */
const WIDE = "hidden sm:table-cell print:table-cell";
const NARROW = "sm:hidden print:hidden";

/** A number that keeps its sign and digits in order inside an Arabic statement. */
function Num({ value, blankZero = false }: { value: number; blankZero?: boolean }) {
  if (blankZero && !value) return null;
  return <bdi dir="ltr">{value < 0 ? `−${formatNumber(-value)}` : formatNumber(value)}</bdi>;
}

/** The phone's one column: what was charged, and (−) what was paid. */
function Movement({ debit, credit }: { debit: number; credit: number }) {
  return (
    <>
      {debit ? (
        <span className="block">
          <Num value={debit} />
        </span>
      ) : null}
      {credit ? (
        <span className="block">
          <Num value={-credit} />
        </span>
      ) : null}
    </>
  );
}

/** A row of the statement that is not a line of the account: brought forward, the totals, the balance at the end. */
function SummaryRow({ label, balance, debit, credit, showPatient, className, testId }: { label: string; balance?: number; debit?: number; credit?: number; showPatient: boolean; className?: string; testId?: string }) {
  return (
    <tr className={className}>
      <td className={WIDE} />
      {showPatient ? <td className={WIDE} /> : null}
      <td className={WIDE} />
      <td className="py-2 pe-2">{label}</td>
      <td className={`${WIDE} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>{debit !== undefined ? <Num value={debit} /> : null}</td>
      <td className={`${WIDE} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>{credit !== undefined ? <Num value={credit} /> : null}</td>
      <td className={`${NARROW} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>{debit !== undefined || credit !== undefined ? <Movement debit={debit ?? 0} credit={credit ?? 0} /> : null}</td>
      <td className="whitespace-nowrap py-2 text-end font-mono tabular-nums" data-testid={testId}>
        {balance !== undefined ? <Num value={balance} /> : null}
      </td>
    </tr>
  );
}

export interface StatementClinic {
  tenantName: string;
  name: string | null;
  address: string | null;
  phone: string | null;
}

export function StatementDocument({ ledger, clinic, language, printedAt }: { ledger: LedgerView; clinic: StatementClinic; language: LedgerLanguage; printedAt: Date }) {
  const ar = language === "ar";
  const t = COPY[language];
  const tz = ledger.timezone;
  const locale = ar ? "ar-EG-u-nu-latn" : "en-GB";
  const long = (d: Date) => formatDateInTz(d, tz, { day: "numeric", month: "long", year: "numeric" }, locale);
  const short = (iso: string) => formatDateInTz(new Date(iso), tz, { day: "2-digit", month: "short", year: "numeric" }, locale);
  const fromKey = (key: string) => long(fromDateKey(key, tz) ?? new Date(`${key}T12:00:00Z`));
  const family = ledger.family;
  const showPatient = ledger.scope === "family";
  const period = ledger.from && ledger.to ? `${fromKey(ledger.from)} – ${fromKey(ledger.to)}` : ledger.from ? `${fromKey(ledger.from)} – ${long(printedAt)}` : ledger.to ? `${t.upTo} ${fromKey(ledger.to)}` : t.everything;
  const head = family?.members.find((m) => m.head) ?? null;
  const addressee = head ?? { id: ledger.patient.id, fullName: ledger.patient.fullName };

  return (
    <article
      dir={ar ? "rtl" : "ltr"}
      lang={language}
      className="print-area space-y-6 rounded-lg border border-border bg-card p-5 text-sm sm:p-8"
      aria-label={`${family ? t.familyTitle : t.title}: ${addressee.fullName}`}
    >
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-display text-lg font-semibold">
            <bdi>{clinic.tenantName}</bdi>
          </p>
          {clinic.name ? (
            <p className="text-muted-foreground">
              <bdi>{clinic.name}</bdi>
            </p>
          ) : null}
          {clinic.address ? (
            <p className="text-xs text-muted-foreground">
              <bdi>{clinic.address}</bdi>
            </p>
          ) : null}
          {clinic.phone ? (
            <p className="text-xs text-muted-foreground">
              <bdi dir="ltr">{clinic.phone}</bdi>
            </p>
          ) : null}
        </div>
        <div className="sm:text-end">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{family ? t.familyTitle : t.title}</h1>
          <p>
            <span className="text-muted-foreground">{t.period}: </span>
            {period}
          </p>
          <p className="text-xs text-muted-foreground">
            {t.printed}: {long(printedAt)}
          </p>
        </div>
      </header>

      <section className="space-y-1">
        <p className="data-label">{t.for}</p>
        <p className="font-medium">
          <bdi>{addressee.fullName}</bdi>
        </p>
        {!family && ledger.patient.phone ? (
          <p className="text-xs text-muted-foreground">
            <bdi dir="ltr">{ledger.patient.phone}</bdi>
          </p>
        ) : null}
        {family ? (
          <p className="text-xs text-muted-foreground">
            {t.family}:{" "}
            {family.members.map((m, i) => (
              <span key={m.id}>
                {i ? (ar ? "، " : ", ") : ""}
                <bdi>{m.fullName}</bdi> ({m.head ? t.paysFor : (relationLabel(m.relation, language) ?? "")})
              </span>
            ))}
          </p>
        ) : null}
      </section>

      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className={`${WIDE} py-2 pe-2 text-start font-normal`}>{t.date}</th>
              {showPatient ? <th className={`${WIDE} py-2 pe-2 text-start font-normal`}>{t.patient}</th> : null}
              <th className={`${WIDE} py-2 pe-2 text-start font-normal`}>{t.reference}</th>
              <th className="py-2 pe-2 text-start font-normal">{t.details}</th>
              <th className={`${WIDE} py-2 pe-2 text-end font-normal`}>{t.charges}</th>
              <th className={`${WIDE} py-2 pe-2 text-end font-normal`}>{t.payments}</th>
              <th className={`${NARROW} py-2 pe-2 text-end font-normal`}>{t.amount}</th>
              <th className="py-2 text-end font-normal">{t.balance}</th>
            </tr>
          </thead>
          <tbody>
            {ledger.from ? <SummaryRow label={t.broughtForward} balance={ledger.opening} showPatient={showPatient} className="border-b border-border/60 text-muted-foreground" /> : null}
            {ledger.entries.map((e) => (
              <tr key={e.id} className="border-b border-border/60 align-top">
                <td className={`${WIDE} whitespace-nowrap py-2 pe-2 text-muted-foreground`}>{short(e.at)}</td>
                {showPatient ? (
                  <td className={`${WIDE} py-2 pe-2`}>
                    <bdi>{e.patientName}</bdi>
                  </td>
                ) : null}
                <td className={`${WIDE} whitespace-nowrap py-2 pe-2 font-mono text-xs`}>
                  <bdi dir="ltr">{e.reference ?? ""}</bdi>
                </td>
                <td className="py-2 pe-2">
                  <LedgerText entry={e} language={language} />
                  {/* On a phone the date, the patient and the reference go under the details. */}
                  <span className={`${NARROW} block text-[11px] text-muted-foreground`}>
                    {short(e.at)}
                    {showPatient ? (
                      <>
                        {" · "}
                        <bdi>{e.patientName}</bdi>
                      </>
                    ) : null}
                    {e.reference ? (
                      <>
                        {" · "}
                        <bdi dir="ltr" className="font-mono">
                          {e.reference}
                        </bdi>
                      </>
                    ) : null}
                  </span>
                </td>
                <td className={`${WIDE} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>
                  <Num value={e.debit} blankZero />
                </td>
                <td className={`${WIDE} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>
                  <Num value={e.credit} blankZero />
                </td>
                <td className={`${NARROW} whitespace-nowrap py-2 pe-2 text-end font-mono tabular-nums`}>
                  <Movement debit={e.debit} credit={e.credit} />
                </td>
                <td className="whitespace-nowrap py-2 text-end font-mono tabular-nums">
                  <Num value={e.balance} />
                </td>
              </tr>
            ))}
            {!ledger.entries.length ? (
              <tr>
                <td className="py-4 text-center text-muted-foreground" colSpan={9}>
                  {t.nothing}
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <SummaryRow label={t.totals} debit={ledger.totals.debit} credit={ledger.totals.credit} showPatient={showPatient} className="border-t border-border text-muted-foreground" />
            <SummaryRow label={t.atEnd} balance={ledger.closing} showPatient={showPatient} className="font-semibold" testId="statement-closing" />
          </tfoot>
        </table>
      </div>

      <p className="text-end font-medium">{balanceWords(ledger.closing, language)}</p>

      {ledger.position.openInvoices.length ? (
        <section className="space-y-1">
          <p className="data-label">{t.openInvoices}</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="py-1 pe-2 text-start font-normal">{t.invoice}</th>
                {showPatient ? <th className={`${WIDE} py-1 pe-2 text-start font-normal`}>{t.patient}</th> : null}
                <th className={`${WIDE} py-1 pe-2 text-start font-normal`}>{t.date}</th>
                <th className={`${WIDE} py-1 pe-2 text-end font-normal`}>{t.total}</th>
                <th className={`${WIDE} py-1 pe-2 text-end font-normal`}>{t.paid}</th>
                <th className="py-1 text-end font-normal">{t.due}</th>
              </tr>
            </thead>
            <tbody>
              {ledger.position.openInvoices.map((i) => (
                <tr key={i.id} className="border-b border-border/60 align-top">
                  <td className="py-1 pe-2">
                    <bdi dir="ltr" className="whitespace-nowrap font-mono">
                      {i.number}
                    </bdi>
                    <span className={`${NARROW} block text-muted-foreground`}>
                      {i.issuedAt ? short(i.issuedAt) : ""}
                      {showPatient ? (
                        <>
                          {" · "}
                          <bdi>{i.patientName}</bdi>
                        </>
                      ) : null}
                    </span>
                  </td>
                  {showPatient ? (
                    <td className={`${WIDE} py-1 pe-2`}>
                      <bdi>{i.patientName}</bdi>
                    </td>
                  ) : null}
                  <td className={`${WIDE} whitespace-nowrap py-1 pe-2`}>{i.issuedAt ? short(i.issuedAt) : ""}</td>
                  <td className={`${WIDE} py-1 pe-2 text-end font-mono tabular-nums`}>
                    <Num value={i.total} />
                  </td>
                  <td className={`${WIDE} py-1 pe-2 text-end font-mono tabular-nums`}>
                    <Num value={i.paid} />
                  </td>
                  <td className="py-1 text-end font-mono tabular-nums">
                    <Num value={i.due} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <footer className="space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
        <p>{t.note}</p>
        <p>
          {t.thanks} <bdi>{clinic.tenantName}</bdi>
        </p>
      </footer>
    </article>
  );
}
