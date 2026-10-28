import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listPayments } from "@/modules/finance/payments";
import { listProcedures } from "@/modules/finance/procedures";
import { listReportDoctors } from "@/modules/reporting/service";
import { listTreatments } from "@/modules/treatments/service";
import { listPriceList } from "@/modules/finance/prices";
import { FinancePatientPanel } from "./finance-patient-panel";
import { toPriceOptions, type PaymentItem, type ProcedureItem } from "./finance-shared";

/**
 * Procedures and payments for this patient: signed procedures, deposits, balance, record a payment.
 * Rendered by the patient page. Server component: fetch what it needs itself.
 *
 * Who sees what: every role that reads patients sees the procedures with
 * their balance; the payment list follows the payments API (roles that take
 * payments, and the owner). Recording a procedure needs patients:write,
 * signing consultations:sign, recording a payment payments:write, voiding a
 * payment the owner (tenant:manage).
 */
export async function PatientFinanceCard({ tenantId, role, patientId, canWrite }: { tenantId: string; userId: string | null; role: UserRole; patientId: string; canWrite: boolean }) {
  if (!can(role, "patients:read")) return null;
  const seesPayments = can(role, "payments:write") || can(role, "finance:read");
  const canPay = canWrite && can(role, "payments:write");
  const canRecordProcedure = canWrite;
  const [patient, timezone, procedures, payments, treatments, doctors, prices] = await Promise.all([
    db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, fullName: true } }),
    getTenantTimezone(tenantId),
    listProcedures(tenantId, { patientId, page: 1, pageSize: 100 }),
    seesPayments ? listPayments(tenantId, { patientId, includeVoided: false, page: 1, pageSize: 100 }) : Promise.resolve(null),
    canRecordProcedure ? listTreatments(tenantId) : Promise.resolve([]),
    canRecordProcedure ? listReportDoctors(tenantId) : Promise.resolve([]),
    canRecordProcedure ? listPriceList(tenantId) : Promise.resolve(null),
  ]);
  if (!patient) return null;

  const procedureItems: ProcedureItem[] = procedures.procedures.map((p) => ({
    id: p.id,
    patientId: p.patientId,
    treatmentName: p.treatment.name,
    treatmentKey: p.treatment.key,
    performedAt: p.performedAt.toISOString(),
    doctorName: p.doctor?.fullName ?? null,
    price: p.price,
    discount: p.discount,
    status: p.status,
    paid: p.paid,
    balance: p.status === "SIGNED" ? p.balance : p.status === "PLANNED" ? Math.max(0, p.balance) : 0,
    notes: p.notes,
    cancelReason: p.cancelReason,
  }));
  const paymentItems: PaymentItem[] | null = payments
    ? payments.payments.map((p) => ({
        id: p.id,
        patientId: p.patientId,
        patientName: p.patient.fullName,
        kind: p.kind,
        method: p.method,
        amount: p.amount,
        paidAt: p.paidAt.toISOString(),
        reference: p.reference,
        note: p.note,
        procedureLabel: p.procedure?.treatment.name ?? null,
        imported: Boolean(p.importBatchId),
      }))
    : null;

  return (
    <FinancePatientPanel
      patient={{ id: patient.id, fullName: patient.fullName }}
      timezone={timezone}
      procedures={procedureItems}
      payments={paymentItems}
      treatments={treatments.map((t) => ({ id: t.id, key: t.key, name: t.name, priceFrom: t.priceFrom, priceTo: t.priceTo, depositAmount: t.depositAmount }))}
      priceItems={prices ? toPriceOptions(prices.items) : []}
      doctors={doctors}
      canRecordProcedure={canRecordProcedure}
      canSign={canWrite && can(role, "consultations:sign")}
      canPay={canPay}
      canVoid={can(role, "tenant:manage")}
    />
  );
}
