import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { ZodError } from "zod";
import { audit } from "@/lib/audit";
import { getActingContext } from "@/lib/auth/session";
import { clientIp, userAgent } from "@/lib/auth/request";
import { db, withTenant } from "@/lib/db";
import { canSeeAccounts, getLedger, type LedgerView } from "@/modules/finance/ledger";
import type { LedgerLanguage } from "@/modules/finance/ledger-copy";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { PrintButton } from "@/components/clinicmind/invoice-actions";
import { StatementDocument } from "@/components/clinicmind/statement-document";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Statement" };

const text = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 10) : undefined);

/**
 * `/dashboard/patients/[id]/statement?from=YYYY-MM-DD&to=YYYY-MM-DD&family=1&lang=ar|en`
 * — the patient's statement of account for any dates (every date when none
 * are given), or their family's, in Arabic or English, ready to print or
 * save as a PDF. For the front desk and the owner; each statement opened is
 * logged.
 */
export default async function StatementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!canSeeAccounts(ctx.role)) {
    return <NotForRole title="Not available for your role" hint="Statements of account are for the front desk and the clinic owner." />;
  }
  const patient = await db.patient.findFirst({
    where: { id, tenantId: ctx.tenantId },
    select: { id: true, fullName: true, language: true, householdHeadId: true, _count: { select: { householdMembers: true } } },
  });
  if (!patient) notFound();

  const query = { from: text(sp.from), to: text(sp.to), family: sp.family === "1" ? "1" : undefined };
  let ledger: LedgerView;
  let problem: string | null = null;
  try {
    ledger = await getLedger(ctx.tenantId, id, query);
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    problem = `${err.issues[0]?.message ?? "Check the dates"}: showing every date instead.`;
    ledger = await getLedger(ctx.tenantId, id, { family: query.family });
  }
  const language: LedgerLanguage = sp.lang === "ar" || sp.lang === "en" ? sp.lang : patient.language === "ar" ? "ar" : "en";
  const [tenant, clinic] = await Promise.all([
    db.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true } }),
    db.clinic.findFirst({ where: { tenantId: ctx.tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { name: true, address: true, phone: true } }),
  ]);
  const inFamily = Boolean(patient.householdHeadId) || patient._count.householdMembers > 0;

  // Who opened whose statement, for which dates, is logged once the page has been sent.
  const requestHeaders = await headers();
  const entry = {
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    actorEmail: ctx.email,
    ip: clientIp({ headers: requestHeaders }),
    device: userAgent({ headers: requestHeaders }),
  };
  after(() =>
    withTenant(entry.tenantId, () =>
      audit({ ...entry, action: "patient.statement.view", entity: "Patient", entityId: patient.id, patientId: patient.id, after: { from: ledger.from, to: ledger.to, scope: ledger.scope, language } }),
    ).catch((err) => console.error("[audit] could not log a statement view", err)),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="no-print space-y-3">
        <Link href={`/dashboard/patients/${patient.id}`} className="text-sm text-accent underline-offset-2 hover:underline">
          ← {patient.fullName}
        </Link>
        <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3" aria-label="Statement period">
          <div className="w-[9.5rem]">
            <Field label="From" htmlFor="statement-from">
              <Input id="statement-from" name="from" type="date" defaultValue={ledger.from ?? ""} />
            </Field>
          </div>
          <div className="w-[9.5rem]">
            <Field label="To" htmlFor="statement-to">
              <Input id="statement-to" name="to" type="date" defaultValue={ledger.to ?? ""} />
            </Field>
          </div>
          <div className="w-[8.5rem]">
            <Field label="Language" htmlFor="statement-lang">
              <Select id="statement-lang" name="lang" defaultValue={language}>
                <option value="en">English</option>
                <option value="ar">العربية</option>
              </Select>
            </Field>
          </div>
          {inFamily ? (
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="family" value="1" defaultChecked={ledger.scope === "family"} className="h-4 w-4 accent-[hsl(var(--accent))]" />
              The whole family
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" className="h-10">
              Show
            </Button>
            <PrintButton />
          </div>
        </form>
        {problem ? <Alert>{problem}</Alert> : null}
      </div>
      <StatementDocument
        ledger={ledger}
        clinic={{ tenantName: tenant?.name ?? "", name: clinic?.name ?? null, address: clinic?.address ?? null, phone: clinic?.phone ?? null }}
        language={language}
        printedAt={new Date()}
      />
    </div>
  );
}
