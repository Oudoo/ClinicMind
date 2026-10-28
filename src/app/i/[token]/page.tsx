import type { Metadata } from "next";
import { FileX2 } from "lucide-react";
import { BRAND } from "@/lib/brand";
import { invoiceByToken } from "@/modules/finance/invoices";
import { InvoiceDocument } from "@/components/clinicmind/invoice-document";
import { PrintButton } from "@/components/clinicmind/invoice-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Invoice",
  robots: { index: false, follow: false },
  // The token is in the address: never pass it on in a Referer header.
  referrer: "no-referrer",
};

/**
 * `/i/[token]` — the patient's copy of an invoice, behind the link in the
 * WhatsApp message. No dashboard and no session: the token is the only key,
 * looked up by its hash; the latest link sent is the one that works.
 */
export default async function PatientInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invoice = await invoiceByToken(token);
  if (!invoice) return <ExpiredLink />;
  const ar = invoice.language === "ar";
  return (
    <main className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="no-print flex justify-end">
          <PrintButton label={ar ? "طباعة أو حفظ PDF" : "Print or save as PDF"} />
        </div>
        <InvoiceDocument invoice={invoice} />
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
          <h1 className="font-display text-xl font-semibold tracking-tight">هذا الرابط لم يعد يعمل</h1>
          <p className="text-sm text-muted-foreground">اطلب من العيادة إرسال الفاتورة مرة أخرى.</p>
        </section>
        <hr className="border-border" />
        <section dir="ltr" lang="en" className="space-y-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">This link no longer works</h2>
          <p className="text-sm text-muted-foreground">Ask the clinic to send the invoice again.</p>
        </section>
      </div>
    </main>
  );
}
