import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db, notDeleted } from "@/lib/db";
import { addDays, dateKeyInTz, startOfDayInTz } from "@/lib/time";
import { QUOTE_VALID_DAYS } from "@/modules/quotes/constants";
import { SectionTitle } from "@/components/ui/primitives";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { QuoteEditor } from "@/components/clinicmind/quote-editor";
import { editorOptions } from "../_editor";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "New treatment plan" };

/** `/dashboard/quotes/new?patientId=` — a new treatment plan, for the patient given or one chosen here. */
export default async function NewQuotePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "quotes:write")) {
    return <NotForRole title="Not available for your role" hint="Treatment plans are made by the doctors, the front desk and the clinic owner." />;
  }
  const patientId = Array.isArray(sp.patientId) ? sp.patientId[0] : sp.patientId;
  const [patient, options] = await Promise.all([
    patientId ? db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId, ...notDeleted }, select: { id: true, fullName: true, phone: true } }) : null,
    editorOptions(ctx.tenantId, ctx.role),
  ]);
  const now = new Date();
  const todayKey = dateKeyInTz(now, options.timezone);
  const me = ctx.isClinician && options.doctors.some((d) => d.id === ctx.userId) ? (ctx.userId ?? "") : "";

  return (
    <div className="space-y-4">
      <SectionTitle
        title="New treatment plan"
        description="Phases of treatments from the price list, priced for the branch today. It stays a draft until it is given to the patient."
        action={
          patient ? (
            <Link href={`/dashboard/patients/${patient.id}`} className="text-sm text-accent underline-offset-2 hover:underline">
              ← {patient.fullName}
            </Link>
          ) : null
        }
      />
      <QuoteEditor
        initial={{
          patient,
          clinicId: options.branch,
          doctorId: me,
          language: "",
          title: "",
          note: "",
          validUntil: dateKeyInTz(addDays(startOfDayInTz(now, options.timezone), QUOTE_VALID_DAYS, options.timezone), options.timezone),
          phases: [{ title: "Treatment", items: [{ priceItemId: "", quantity: 1, site: "", discount: 0, discountReason: "", discountNote: "" }] }],
        }}
        clinics={options.clinics}
        doctors={options.doctors}
        priceItems={options.priceItems}
        discountLimit={options.discountLimit}
        todayKey={todayKey}
      />
    </div>
  );
}
