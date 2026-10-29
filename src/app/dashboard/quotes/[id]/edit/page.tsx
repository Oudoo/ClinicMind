import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { dateKeyInTz } from "@/lib/time";
import type { DiscountReasonValue } from "@/modules/finance/constants";
import { getQuote, QuoteNotFoundError } from "@/modules/quotes/service";
import { SectionTitle } from "@/components/ui/primitives";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { QuoteEditor } from "@/components/clinicmind/quote-editor";
import { editorOptions } from "../../_editor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit treatment plan" };

/** `/dashboard/quotes/[id]/edit` — change a draft; a plan given to the patient goes to its page instead. */
export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "quotes:write")) {
    return <NotForRole title="Not available for your role" hint="Treatment plans are made by the doctors, the front desk and the clinic owner." />;
  }
  const quote = await getQuote(ctx.tenantId, id).catch((err: unknown) => {
    if (err instanceof QuoteNotFoundError) return null;
    throw err;
  });
  if (!quote) notFound();
  if (quote.status !== "DRAFT") redirect(`/dashboard/quotes/${id}`);
  const options = await editorOptions(ctx.tenantId, ctx.role, quote.clinic.id);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Edit the treatment plan"
        description="Saved, it is priced again from today's list. It stays a draft until it is given to the patient."
        action={
          <Link href={`/dashboard/quotes/${id}`} className="text-sm text-accent underline-offset-2 hover:underline">
            ← Back to the plan
          </Link>
        }
      />
      <QuoteEditor
        quoteId={id}
        initial={{
          patient: { id: quote.patient.id, fullName: quote.patient.fullName, phone: quote.patient.phone },
          clinicId: quote.clinic.id,
          doctorId: quote.doctor?.id ?? "",
          language: quote.language,
          title: quote.title ?? "",
          note: quote.note ?? "",
          validUntil: quote.validUntilKey,
          phases: quote.phases.map((title, p) => ({
            title,
            items: quote.items
              .filter((i) => i.phase === p)
              .map((i) => ({
                id: i.id,
                priceItemId: i.priceItemId,
                quantity: i.quantity,
                site: i.site ?? "",
                discount: i.discount,
                discountReason: (i.discountReason ?? "") as DiscountReasonValue | "",
                discountNote: i.discountNote ?? "",
              })),
          })),
        }}
        clinics={options.clinics}
        doctors={options.doctors}
        priceItems={options.priceItems}
        discountLimit={options.discountLimit}
        todayKey={dateKeyInTz(new Date(), options.timezone)}
      />
    </div>
  );
}
