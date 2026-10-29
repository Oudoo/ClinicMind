import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateTimeInTz } from "@/lib/time";
import { getInvoice, InvoiceNotFoundError } from "@/modules/finance/invoices";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { InvoiceDocument } from "@/components/clinicmind/invoice-document";
import { InvoiceActions } from "@/components/clinicmind/invoice-actions";
import { discountLimitOf } from "@/modules/finance/discounts";
import { db } from "@/lib/db";
import { splitInvoice } from "@/modules/insurance/claims";
import { InvoiceSplitPanel } from "@/components/clinicmind/invoice-split";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Invoice" };

/**
 * `/dashboard/finance/invoices/[id]` — one invoice as the patient will see it,
 * with what can be done with it: a draft is issued, discarded or has a line
 * discounted (within the role's limit); an issued one is printed, sent on
 * WhatsApp or (the owner) written off or cancelled with a credit note.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="Invoices are for the front desk and the clinic owner." />;
  }
  const invoice = await getInvoice(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof InvoiceNotFoundError) return null;
    throw err;
  });
  if (!invoice) notFound();
  const canAct = can(ctx.role, "payments:write");
  const discountLimit = canAct && invoice.status === "DRAFT" ? await discountLimitOf(ctx.tenantId, ctx.role) : 0;
  // A covered patient's draft: how it will be shared with the payer when issued.
  const split = invoice.status === "DRAFT" && (await db.coverage.count({ where: { tenantId: ctx.tenantId, patientId: invoice.patient.id } })) ? await splitInvoice(db, ctx.tenantId, invoice.id) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <Link href={`/dashboard/patients/${invoice.patient.id}`} className="text-accent underline-offset-2 hover:underline">
            ← {invoice.patient.fullName}
          </Link>
          {invoice.sentAt ? <span className="ms-3 text-xs text-muted-foreground">Sent {formatDateTimeInTz(new Date(invoice.sentAt), invoice.timezone)}</span> : null}
        </div>
        {canAct ? (
          <InvoiceActions
            invoice={{
              id: invoice.id,
              status: invoice.status,
              number: invoice.number,
              total: invoice.total,
              due: invoice.due,
              lines: invoice.status === "DRAFT" ? invoice.lines.map((l) => ({ chargeId: l.chargeId, description: l.description, amount: l.amount })) : undefined,
              discountOf: invoice.discountOf,
              language: invoice.language,
              patientId: invoice.patient.id,
              patientName: invoice.patient.fullName,
              sentAt: invoice.sentAt,
            }}
            canCancel={can(ctx.role, "tenant:manage")}
            discountLimit={discountLimit}
          />
        ) : null}
      </div>
      {split ? <InvoiceSplitPanel split={split} /> : null}
      <InvoiceDocument invoice={invoice} />
    </div>
  );
}
