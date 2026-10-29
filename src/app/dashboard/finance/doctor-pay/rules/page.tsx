import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { payDoctors } from "@/modules/finance/doctor-pay";
import { SectionTitle } from "@/components/ui/primitives";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { PayRulesEditor } from "@/components/clinicmind/doctor-pay-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pay rules" };

/**
 * `/dashboard/finance/doctor-pay/rules` — the owner (`tenant:manage`) sets how
 * each doctor, the owner and each nurse is paid: per category of the price
 * list, for consultation fees, and for everything else.
 */
export default async function PayRulesPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "tenant:manage")) {
    return <NotForRole title="Not available for your role" hint="The clinic owner sets the pay rules." />;
  }
  const doctors = await payDoctors(ctx.tenantId);
  return (
    <div className="space-y-6">
      <div className="text-sm">
        <Link href="/dashboard/finance/doctor-pay" className="text-accent underline-offset-2 hover:underline">
          ← Doctor pay
        </Link>
      </div>
      <SectionTitle
        title="Pay rules"
        description="For each person, a rule for everything they do and, where it differs, one per category. A share of what is billed or of what is collected for their work (the lab and material costs taken off first, if you choose), or a fixed fee per session. Changes apply to every month not closed yet."
      />
      <PayRulesEditor doctors={doctors} />
    </div>
  );
}
